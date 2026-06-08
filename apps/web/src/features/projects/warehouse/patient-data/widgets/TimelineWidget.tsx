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
import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'
import {
  subscribeTimelineSync,
  broadcastTimelineRange,
  getTimelineRange,
} from '../timeline-sync'

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

/** Px reserved at the bottom so the range selector stays inside the card. */
const RANGE_SELECTOR_RESERVE = 6

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

/** Resolve a stored color (palette name or hex) to a concrete hex value. */
function resolveConceptColor(color: string | undefined): string | null {
  if (!color) return null
  if (color.startsWith('#')) return color
  return COLOR_PALETTE.find((c) => c.name === color)?.hex ?? null
}

/**
 * Series colors: each concept uses its configured color when set, otherwise
 * the rotating chart palette (keyed by index so defaults stay stable).
 */
function getSeriesColors(
  names: string[],
  conceptIdByName: Record<string, number>,
  conceptColors: Record<string, string>,
): string[] {
  return names.map((name, i) => {
    const id = conceptIdByName[name]
    const custom = id != null ? resolveConceptColor(conceptColors[String(id)]) : null
    return custom ?? resolveCssColor(CSS_COLORS[i % CSS_COLORS.length])
  })
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
  const tabId = widget?.tabId ?? ''

  const yAxisFromZero = config.yAxisFromZero ?? false
  const syncTimeRange = config.syncTimeRange ?? false
  const stepPlot = config.stepPlot ?? false
  const showPoints = config.showPoints ?? true
  // strokeWidth comes from a schema `select` (string) but older configs may hold a number.
  const strokeWidth = Number(config.strokeWidth ?? 1.5) || 1.5
  const conceptColors = config.conceptColors ?? {}
  const conceptColorsKey = JSON.stringify(conceptColors)

  // Stable string key so the fetch effect doesn't re-run on array identity churn.
  const conceptIds = config.conceptIds ?? []
  const conceptIdsKey = conceptIds.join(',')

  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const wrapperRef = useRef<HTMLDivElement>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const dygraphRef = useRef<Dygraph | null>(null)
  // True while we apply a range received from another timeline, so the
  // resulting drawCallback doesn't re-broadcast (which would ping-pong /
  // recurse between synced timelines and freeze the interaction).
  const applyingSyncRef = useRef(false)
  // Last x-range we broadcast, so drawCallback (which fires on every redraw)
  // only broadcasts when the visible window actually changed.
  const lastBroadcastRef = useRef<[number, number] | null>(null)
  const [data, setData] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch data
  useEffect(() => {
    if (
      !dataSourceId ||
      !schemaMapping ||
      !patientId ||
      conceptIds.length === 0
    ) {
      setData([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    // Debounce the fetch: switching patients resets visitId to null and the
    // sidebar then auto-selects the first visit, flipping visitId back to a
    // real value a moment later. Without this delay the timeline would fetch
    // twice (once for the transient null) — causing a visible reload / "No
    // data" flash. A short debounce collapses the cascade into one fetch.
    const timer = setTimeout(() => {
      const sql = buildTimelineQuery(
        schemaMapping,
        conceptIds,
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
    }, 120)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, schemaMapping, patientId, visitId, conceptIdsKey])

  // Reshape data for dygraphs: Array<[Date, number|null, ...]>
  const { chartData, conceptNames, conceptIdByName } = useMemo(() => {
    if (data.length === 0) return { chartData: null, conceptNames: [], conceptIdByName: {} as Record<string, number> }

    const nameSet = new Set<string>()
    const idByName: Record<string, number> = {}
    for (const row of data) {
      nameSet.add(row.concept_name)
      if (idByName[row.concept_name] == null) idByName[row.concept_name] = row.concept_id
    }
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

    return { chartData: rows, conceptNames: names, conceptIdByName: idByName }
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

    const colors = getSeriesColors(conceptNames, conceptIdByName, conceptColors)
    const theme = getThemeColors()

    const opts: dygraphs.Options = {
      labels: ['Date', ...conceptNames],
      colors,
      strokeWidth,
      stepPlot,
      drawPoints: showPoints,
      pointSize: 2.5,
      highlightCircleSize: 4,
      connectSeparatedPoints: true,
      legend: 'follow',
      labelsSeparateLines: true,
      // Custom legend: a grid so the values line up in their own right-aligned
      // column (label on the left, number on the right) for easy comparison.
      legendFormatter: (legendData) => {
        if (legendData.x == null) return ''
        const dateStr = legendData.xHTML
        const rows = legendData.series
          .filter((s) => s.isVisible && s.yHTML != null)
          .map(
            (s) =>
              `<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${s.color};margin-right:4px;flex:none"></span>` +
              `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.labelHTML}</span>` +
              `<span style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${s.yHTML}</span>`,
          )
          .join('')
        return (
          `<div style="font-weight:600;padding-bottom:3px;margin-bottom:3px;border-bottom:1px solid var(--border)">${dateStr}</div>` +
          `<div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:1px 6px">${rows}</div>`
        )
      },
      ...(yAxisFromZero ? { includeZero: true } : {}),

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
          ...(yAxisFromZero ? { includeZero: true } : {}),
        },
      },

      // Sync: broadcast our visible x-range on every redraw — drawCallback (not
      // zoomCallback) is the only hook that also fires when the range selector
      // is *panned* (dygraphs skips zoomCallback for pans). We broadcast only
      // when the window actually changed, and never while applying a peer's range.
      drawCallback: (g) => {
        if (!syncTimeRange || applyingSyncRef.current) return
        const [min, max] = g.xAxisRange()
        const last = lastBroadcastRef.current
        if (last && Math.abs(last[0] - min) < 1 && Math.abs(last[1] - max) < 1) return
        lastBroadcastRef.current = [min, max]
        broadcastTimelineRange(tabId, widgetId, { min, max })
      },

      // Range selector (mini timeline for navigation)
      showRangeSelector: true,
      rangeSelectorHeight: 30,
      rangeSelectorPlotFillColor: theme.rangeSelectorPlotFillColor,
      rangeSelectorPlotStrokeColor: theme.rangeSelectorPlotStrokeColor,
      rangeSelectorForegroundStrokeColor: theme.rangeSelectorForegroundStrokeColor,
      rangeSelectorBackgroundStrokeColor: theme.rangeSelectorBackgroundStrokeColor,
      rangeSelectorAlpha: theme.rangeSelectorAlpha,

      // Interaction: default model supports drag-to-zoom on x-axis.
      interactionModel: Dygraph.defaultInteractionModel,
      // No animation: zoomCallback then fires immediately on every change so
      // synced timelines follow live during a range-selector drag (animated
      // zooms only fire the callback once, at the end of the transition).
      animatedZooms: false,
    }

    // Pin dygraph to the WRAPPER's measured pixel size (stable; dygraphs mutates
    // the inner container's inline size, so measuring it would feed back into a
    // shrinking ResizeObserver loop). Reserve a small bottom inset so the range
    // selector stays inside the card.
    const rect = (wrapperRef.current ?? container).getBoundingClientRect()
    const sizedOpts: dygraphs.Options =
      rect.width > 0 && rect.height > 0
        ? { ...opts, width: Math.floor(rect.width), height: Math.floor(rect.height) - RANGE_SELECTOR_RESERVE }
        : opts

    if (dygraphRef.current) {
      dygraphRef.current.updateOptions({
        file: chartData as unknown as dygraphs.Data,
        ...sizedOpts,
      })
    } else {
      dygraphRef.current = new Dygraph(
        container,
        chartData as unknown as dygraphs.Data,
        sizedOpts,
      )
    }

    // NOTE: do NOT set draggable=false on the range-selector handles. Dygraphs
    // starts the handle *resize* on the native `dragstart` event (see
    // rangeselector: dragStartEvent = 'dragstart'); disabling drag kills it and
    // only the pan (fgcanvas mousedown) keeps working. dygraphs' own
    // onZoomStart cancels the event, so no ghost drag-image appears.
    container.querySelectorAll<HTMLImageElement>('.dygraph-rangesel-zoomhandle')
      .forEach((img) => { img.style.zIndex = '10' })

    // Re-measure after layout settles, from the stable wrapper.
    requestAnimationFrame(() => {
      const g = dygraphRef.current
      const wrap = wrapperRef.current
      if (!g || !wrap) return
      const r = wrap.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) g.resize(Math.floor(r.width), Math.floor(r.height) - RANGE_SELECTOR_RESERVE)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartData, conceptNames, conceptIdByName, getThemeColors, yAxisFromZero, stepPlot, showPoints, strokeWidth, syncTimeRange, conceptColorsKey, tabId, widgetId])

  // Sync: when another timeline in this tab broadcasts a range, adopt it.
  useEffect(() => {
    if (!syncTimeRange || !tabId) return

    // Adopt the current shared window immediately when sync is turned on.
    const current = getTimelineRange(tabId)
    if (current && dygraphRef.current) {
      dygraphRef.current.updateOptions({ dateWindow: [current.min, current.max ?? current.min] })
    }

    const unsubscribe = subscribeTimelineSync(tabId, (range, sourceId) => {
      if (sourceId === widgetId) return
      const g = dygraphRef.current
      if (!g) return
      // Skip if we're already showing this window — stops the ping-pong where
      // applying a peer's range fires our own zoomCallback and bounces back.
      const cur = g.xAxisRange()
      const target: [number, number] | null = range
        ? [range.min, range.max ?? range.min]
        : null
      if (target && Math.abs(cur[0] - target[0]) < 1 && Math.abs(cur[1] - target[1]) < 1) return
      applyingSyncRef.current = true
      try {
        if (target) {
          g.updateOptions({ dateWindow: target })
        } else {
          g.resetZoom()
        }
      } finally {
        // Reset after the (possibly animated) zoom settles.
        setTimeout(() => { applyingSyncRef.current = false }, 0)
      }
    })
    return unsubscribe
  }, [syncTimeRange, tabId, widgetId, chartData])

  // Resize when the container changes. Pass explicit pixel dimensions so
  // dygraphs lays the range selector out within the box — relying on the
  // `h-full` percentage alone lets it render a few px past the bottom (the
  // range selector then sits under the card's overflow-hidden edge, which both
  // hides it and makes its zoom handles unclickable).
  useEffect(() => {
    const wrap = wrapperRef.current
    if (!wrap) return
    const apply = () => {
      const g = dygraphRef.current
      if (!g) return
      const { width, height } = wrap.getBoundingClientRect()
      if (width > 0 && height > 0) g.resize(Math.floor(width), Math.floor(height) - RANGE_SELECTOR_RESERVE)
    }
    // Observe the stable wrapper, never the dygraph-mutated inner container.
    const observer = new ResizeObserver(apply)
    observer.observe(wrap)
    apply()
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
        const colors = getSeriesColors(conceptNames, conceptIdByName, conceptColors)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartData, conceptNames, conceptIdByName, getThemeColors, conceptColorsKey])

  // Determine overlay message (shown on top of the chart container)
  let overlayMessage: string | null = null
  let showConfigureButton = false

  if (conceptIds.length === 0) {
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
    <div ref={wrapperRef} className="relative h-full w-full timeline-widget">
      {/* Dygraphs mounts here — always in the DOM to avoid removeChild errors.
          Absolutely positioned so the inline width/height dygraphs writes on it
          never feeds back into the parent's layout (which would loop the
          ResizeObserver and progressively shrink the chart).
          stopPropagation prevents react-grid-layout drag handlers from capturing
          mousedown/touchstart, which would block dygraphs zoom & range selector. */}
      <div
        ref={chartContainerRef}
        className="absolute inset-0"
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
