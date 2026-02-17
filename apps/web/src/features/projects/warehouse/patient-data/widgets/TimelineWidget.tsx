import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Dygraph, { type dygraphs } from 'dygraphs'
import 'dygraphs/dist/dygraph.css'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePatientChartContext } from '../PatientChartContext'
import {
  usePatientChartStore,
  type TimelineConfig,
} from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildTimelineQuery } from '@/lib/duckdb/patient-data-queries'

interface TimelineWidgetProps {
  widgetId: string
  onConfigureConcepts?: () => void
}

interface TimelineRow {
  concept_id: number
  concept_name: string
  value: number
  event_date: unknown // DuckDB-WASM returns Date, BigInt, or string
}

const CSS_COLORS = [
  '--color-chart-1',
  '--color-chart-2',
  '--color-chart-3',
  '--color-chart-4',
  '--color-chart-5',
]

function resolveCssColor(varName: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim()
  if (raw.startsWith('var(')) {
    const inner = raw.slice(4, -1).trim()
    return resolveCssColor(inner)
  }
  return raw || '#888'
}

function resolveCssVar(varName: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim()
}

function getSeriesColors(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    resolveCssColor(CSS_COLORS[i % CSS_COLORS.length]),
  )
}

/**
 * Coerce a DuckDB-WASM date value to a JS Date.
 * DuckDB-WASM Arrow results may return:
 *  - Date object (already good)
 *  - BigInt microseconds since epoch
 *  - Number milliseconds since epoch
 *  - String like "2024-01-15" or "2024-01-15 14:30:00"
 */
function toDate(d: unknown): Date {
  if (d instanceof Date) return d
  if (typeof d === 'bigint') {
    // Arrow timestamps: microseconds since epoch
    return new Date(Number(d / 1000n))
  }
  if (typeof d === 'number') {
    return new Date(d)
  }
  // String fallback
  const s = String(d)
  // Replace space separator with T for ISO compliance
  const normalized = s.includes('T') ? s : s.replace(' ', 'T')
  const date = new Date(normalized)
  if (isNaN(date.getTime())) return new Date(0)
  return date
}

/** Stable string key for a date value (milliseconds). */
function dateKey(d: unknown): number {
  return toDate(d).getTime()
}

export function TimelineWidget({ widgetId, onConfigureConcepts }: TimelineWidgetProps) {
  const { t } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { widgets, selectedPatientId, selectedVisitId } =
    usePatientChartStore()

  const widget = widgets.find((w) => w.id === widgetId)
  const config = (widget?.config ?? {
    conceptIds: [],
  }) as TimelineConfig

  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const chartContainerRef = useRef<HTMLDivElement>(null)
  const dygraphRef = useRef<Dygraph | null>(null)
  const [data, setData] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch data
  useEffect(() => {
    if (
      !dataSourceId ||
      !schemaMapping ||
      !patientId ||
      config.conceptIds.length === 0
    ) {
      setData([])
      return
    }

    let cancelled = false
    setLoading(true)

    const sql = buildTimelineQuery(
      schemaMapping,
      config.conceptIds,
      patientId,
      visitId,
    )

    if (!sql) {
      setData([])
      setLoading(false)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) setData((rows as unknown as TimelineRow[]) ?? [])
      })
      .catch((err) => {
        console.error('Timeline query failed:', err)
        if (!cancelled) setData([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, visitId, config.conceptIds])

  // Reshape data for dygraphs: Array<[Date, number|null, ...]>
  const { chartData, conceptNames } = useMemo(() => {
    if (data.length === 0) return { chartData: null, conceptNames: [] }

    const nameSet = new Set<string>()
    for (const row of data) nameSet.add(row.concept_name)
    const names = [...nameSet]

    // Collect all unique timestamps (keyed by ms), sorted
    const dateMap = new Map<number, Date>()
    for (const row of data) {
      const ms = dateKey(row.event_date)
      if (!dateMap.has(ms)) dateMap.set(ms, toDate(row.event_date))
    }
    const sortedMs = [...dateMap.keys()].sort((a, b) => a - b)

    // Build lookup: conceptName -> Map<ms, value>
    const lookup = new Map<string, Map<number, number>>()
    for (const name of names) lookup.set(name, new Map())
    for (const row of data) {
      lookup.get(row.concept_name)!.set(dateKey(row.event_date), Number(row.value))
    }

    // Build dygraphs data: [Date, val1, val2, ...]
    const rows: Array<[Date, ...(number | null)[]]> = sortedMs.map((ms) => {
      const vals: (number | null)[] = names.map((name) =>
        lookup.get(name)!.get(ms) ?? null,
      )
      return [dateMap.get(ms)!, ...vals]
    })

    return { chartData: rows, conceptNames: names }
  }, [data])

  // Resolve theme-aware colors for canvas-drawn elements
  const getThemeColors = useCallback(() => {
    const isDark = document.documentElement.classList.contains('dark')
    return {
      gridLineColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
      axisLineColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
      axisLabelColor: resolveCssVar('--muted-foreground') || (isDark ? '#999' : '#666'),
      rangeSelectorPlotFillColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
      rangeSelectorPlotStrokeColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)',
      rangeSelectorForegroundStrokeColor: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)',
      rangeSelectorBackgroundStrokeColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
      rangeSelectorAlpha: isDark ? 0.7 : 0.5,
    }
  }, [])

  // Create / update / destroy dygraph instance
  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return

    // If no data, destroy existing chart
    if (!chartData || chartData.length === 0 || conceptNames.length === 0) {
      if (dygraphRef.current) {
        dygraphRef.current.destroy()
        dygraphRef.current = null
      }
      return
    }

    const colors = getSeriesColors(conceptNames.length)
    const theme = getThemeColors()

    const opts: dygraphs.Options = {
      labels: ['Date', ...conceptNames],
      colors,
      strokeWidth: 1.5,
      drawPoints: true,
      pointSize: 2.5,
      highlightCircleSize: 4,
      connectSeparatedPoints: true,
      legend: 'follow',
      labelsSeparateLines: true,

      // Grid & axes
      gridLineColor: theme.gridLineColor,
      axisLineColor: theme.axisLineColor,
      axes: {
        x: {
          axisLabelFontSize: 10,
          drawGrid: true,
        },
        y: {
          axisLabelFontSize: 10,
          drawGrid: true,
          axisLabelWidth: 50,
        },
      },

      // Range selector (mini timeline for navigation)
      showRangeSelector: true,
      rangeSelectorHeight: 30,
      rangeSelectorPlotFillColor: theme.rangeSelectorPlotFillColor,
      rangeSelectorPlotStrokeColor: theme.rangeSelectorPlotStrokeColor,
      rangeSelectorForegroundStrokeColor: theme.rangeSelectorForegroundStrokeColor,
      rangeSelectorBackgroundStrokeColor: theme.rangeSelectorBackgroundStrokeColor,
      rangeSelectorAlpha: theme.rangeSelectorAlpha,

      // Interaction: default model supports drag-to-zoom on x-axis
      interactionModel: Dygraph.defaultInteractionModel,
      animatedZooms: true,
    }

    if (dygraphRef.current) {
      dygraphRef.current.updateOptions({
        file: chartData as unknown as dygraphs.Data,
        ...opts,
      })
    } else {
      dygraphRef.current = new Dygraph(
        container,
        chartData as unknown as dygraphs.Data,
        opts,
      )
    }

    // Prevent native browser image drag on range selector handles
    container.querySelectorAll<HTMLImageElement>('.dygraph-rangesel-zoomhandle')
      .forEach((img) => { img.draggable = false })
  }, [chartData, conceptNames, getThemeColors])

  // Resize when container changes
  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      dygraphRef.current?.resize()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Destroy on unmount
  useEffect(() => {
    return () => {
      if (dygraphRef.current) {
        dygraphRef.current.destroy()
        dygraphRef.current = null
      }
    }
  }, [])

  // Re-render chart when theme changes (dark ↔ light)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (dygraphRef.current && chartData) {
        const theme = getThemeColors()
        const colors = getSeriesColors(conceptNames.length)
        dygraphRef.current.updateOptions({
          colors,
          gridLineColor: theme.gridLineColor,
          axisLineColor: theme.axisLineColor,
          rangeSelectorPlotFillColor: theme.rangeSelectorPlotFillColor,
          rangeSelectorPlotStrokeColor: theme.rangeSelectorPlotStrokeColor,
          rangeSelectorForegroundStrokeColor: theme.rangeSelectorForegroundStrokeColor,
          rangeSelectorBackgroundStrokeColor: theme.rangeSelectorBackgroundStrokeColor,
          rangeSelectorAlpha: theme.rangeSelectorAlpha,
        })
      }
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [chartData, conceptNames, getThemeColors])

  // Determine overlay message (shown on top of the chart container)
  let overlayMessage: string | null = null
  let showConfigureButton = false

  if (config.conceptIds.length === 0) {
    overlayMessage = t('patient_data.configure_concepts')
    showConfigureButton = true
  } else if (!patientId) {
    overlayMessage = t('patient_data.select_patient_first')
  } else if (loading) {
    overlayMessage = t('common.loading')
  } else if (data.length === 0) {
    overlayMessage = t('patient_data.no_data')
  }

  return (
    <div className="relative h-full w-full timeline-widget">
      {/* Dygraphs mounts here — always in the DOM to avoid removeChild errors.
          stopPropagation prevents react-grid-layout drag handlers from capturing
          mousedown/touchstart, which would block dygraphs zoom & range selector. */}
      <div
        ref={chartContainerRef}
        className="h-full w-full"
        style={{ visibility: overlayMessage ? 'hidden' : 'visible' }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      />
      {/* Overlay for empty/loading states */}
      {overlayMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground">{overlayMessage}</p>
          {showConfigureButton && onConfigureConcepts && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={onConfigureConcepts}
            >
              <Settings2 size={12} />
              {t('patient_data.select_concepts')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
