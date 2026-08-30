import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Dygraph, { type dygraphs } from 'dygraphs'
import 'dygraphs/dist/dygraph.css'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePatientChartContext } from '../PatientChartContext'
import { useTabVisible } from '../TabVisibilityContext'
import {
  usePatientChartStore,
  type TimelineConfig,
} from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildTimelineQuery } from '@/lib/duckdb/patient-data-queries'
import { conceptColorHex } from '@/lib/concept-colors'
import {
  subscribeTimelineSync,
  broadcastTimelineRange,
  getTimelineRange,
  forgetTimelineRange,
  syncChannel,
  getGutter,
  subscribeGutter,
} from '../timeline-sync'
import { TimelineCanvas, type TimelineSeries } from './TimelineCanvas'
import { classifySeries, resolveRenderer } from './timeline-shape'
import {
  dygraphAxisLabelWidth,
  TIMELINE_GUTTER,
  TIMELINE_PAD_R,
  formatAxisTick,
  tickShowsClock,
  type TimeWindow,
} from './timeline-view'

interface TimelineWidgetProps {
  widgetId: string
  /** The config to render. The editor's preview passes its unsaved draft here, so
   *  reading the store instead would show the last saved state — a widget that
   *  still says "no concepts" while the SQL tab already lists them. */
  config?: Record<string, unknown>
  onConfigureConcepts?: () => void
}

interface TimelineRow {
  concept_id: number
  concept_name: string
  value: number
  /** Set for a categorical observation, which has no number to plot. */
  value_string?: string | null
  /** Unit of measure, when the schema maps one. */
  unit?: string | null
  /** Administration route, when mapped — what tells a drip from a bolus. */
  route?: string | null
  event_date: unknown // DuckDB-WASM returns Date, BigInt, or string
  /** Set for an event that lasts, which draws as a block rather than a point. */
  end_date?: unknown
}

/** Px reserved at the bottom so the range selector stays inside the card. */
const RANGE_SELECTOR_RESERVE = 6

function resolveCssVar(varName: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim()
}

/**
 * Series colors: each concept uses its configured color when set, otherwise the
 * auto color for its position in the widget's own conceptIds list — NOT its
 * position among the series actually returned, so a concept keeps its color even
 * when another one has no data for the selected patient and drops out.
 */
function getSeriesColors(
  names: string[],
  conceptIdByName: Record<string, number>,
  conceptColors: Record<string, string>,
  conceptIds: number[],
): string[] {
  return names.map((name, i) => {
    const id = conceptIdByName[name]
    const position = id != null ? conceptIds.indexOf(id) : -1
    return conceptColorHex(
      id != null ? conceptColors[String(id)] : undefined,
      position >= 0 ? position : i,
    )
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

export function TimelineWidget({
  widgetId,
  config: configProp,
  onConfigureConcepts,
}: TimelineWidgetProps) {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const visible = useTabVisible()
  // Narrow selectors: a bare usePatientChartStore() re-renders every timeline on
  // the grid whenever any widget or selection changes.
  const widget = usePatientChartStore((s) => s.widgets.find((w) => w.id === widgetId))
  const selectedPatientId = usePatientChartStore((s) => s.selectedPatientId)
  const selectedVisitId = usePatientChartStore((s) => s.selectedVisitId)

  const config = (configProp ??
    widget?.config ?? { conceptIds: [] }) as unknown as TimelineConfig
  const tabId = widget?.tabId ?? ''
  // The board owns the cross-tab setting, and the tab is what ties this widget
  // to it. Selected narrowly so an unrelated board edit doesn't redraw us.
  const boardId = usePatientChartStore(
    (s) => s.tabs.find((tb) => tb.id === tabId)?.patientDashboardId,
  )
  const syncAcrossTabs = usePatientChartStore(
    (s) => s.dashboards.find((d) => d.id === boardId)?.syncTimelinesAcrossTabs ?? false,
  )

  const yAxisFromZero = config.yAxisFromZero ?? false
  const syncTimeRange = config.syncTimeRange ?? false
  const channel = syncChannel(tabId, boardId, syncAcrossTabs)

  /**
   * The gutter a synced data overview on this tab is using, so the two share a
   * time axis. Null when there is none to follow, and the timeline keeps its
   * own fixed width — which is also what keeps two timelines aligned with each
   * other when no overview is present.
   */
  const [sharedGutter, setSharedGutter] = useState<number | null>(null)
  useEffect(() => {
    if (!syncTimeRange || !tabId) {
      setSharedGutter(null)
      return
    }
    setSharedGutter(getGutter(tabId))
    return subscribeGutter(tabId, setSharedGutter)
  }, [syncTimeRange, tabId])
  const gutter = sharedGutter ?? TIMELINE_GUTTER
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
  /** The gutter the live dygraph was BUILT with, to tell an in-place update
   *  from a rebuild — see the create/update effect. */
  const gutterRef = useRef<number | null>(null)
  const [data, setData] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch data
  useEffect(() => {
    // A kept-alive tab stays mounted, so without this every hidden timeline would
    // re-query on each patient change. Returning early KEEPS the current data
    // rather than clearing it — clearing would defeat keep-alive by forcing a
    // refetch on every reveal. `visible` is a dep, so the fetch runs on reveal.
    if (!visible) return
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
  }, [visible, dataSourceId, schemaMapping, patientId, visitId, conceptIdsKey])

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

  // One series per concept, for the mixed-shape renderer. Built from the same
  // rows as chartData, which flattens them onto a shared time axis instead.
  const series = useMemo<TimelineSeries[]>(() => {
    if (data.length === 0) return []
    const byConcept = new Map<number, TimelineSeries>()
    const colours = getSeriesColors(conceptNames, conceptIdByName, conceptColors, conceptIds)
    conceptNames.forEach((name, i) => {
      const id = conceptIdByName[name]
      if (id != null) {
        byConcept.set(id, { conceptId: id, name, colour: colours[i], unit: null, events: [] })
      }
    })
    // Units seen per concept: a value carries its unit, but a concept charted in
    // two of them (mg and mL, kg and lb) must show neither rather than whichever
    // row happened to come first.
    const unitsByConcept = new Map<number, Set<string>>()
    for (const row of data) {
      const s = byConcept.get(row.concept_id)
      if (!s) continue
      if (row.unit) {
        const seen = unitsByConcept.get(row.concept_id) ?? new Set<string>()
        seen.add(row.unit)
        unitsByConcept.set(row.concept_id, seen)
      }
      const value = row.value == null ? null : Number(row.value)
      s.events.push({
        start: dateKey(row.event_date),
        end: row.end_date == null ? null : dateKey(row.end_date),
        value: value != null && Number.isFinite(value) ? value : null,
        text: row.value_string ?? null,
        conceptId: String(row.concept_id),
        route: row.route ?? null,
      })
    }
    for (const [id, seen] of unitsByConcept) {
      const s = byConcept.get(id)
      if (s && seen.size === 1) s.unit = [...seen][0]
    }
    return [...byConcept.values()].filter((s) => s.events.length > 0)
  }, [data, conceptNames, conceptIdByName, conceptColors, conceptIds])

  // Which renderer draws this widget. Dygraph plots continuous numeric series and
  // nothing else, so `auto` uses it exactly while it is capable.
  const renderer = useMemo(() => {
    const shapes = series.map((s) =>
      classifySeries({
        conceptId: s.conceptId,
        values: s.events.map((e) => (e.value != null ? e.value : e.text)),
        timestamps: s.events.map((e) => e.start),
        durational: s.events.some((e) => e.end != null),
      }),
    )
    return resolveRenderer(config.engine, shapes)
  }, [series, config.engine])

  // Full extent of the record, and the window currently shown.
  const bounds = useMemo<TimeWindow>(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const s of series) {
      for (const e of s.events) {
        if (e.start < lo) lo = e.start
        const end = e.end ?? e.start
        if (end > hi) hi = end
      }
    }
    return lo <= hi ? { lo, hi } : { lo: 0, hi: 1 }
  }, [series])
  const [canvasView, setCanvasView] = useState<TimeWindow | null>(null)
  // Reset the window whenever the record changes underneath it.
  useEffect(() => { setCanvasView(null) }, [bounds.lo, bounds.hi])
  const view = canvasView ?? bounds

  // A different patient means different dates entirely, so the window the
  // channel remembers is meaningless now — adopting it would open every synced
  // timeline on empty space.
  //
  // Only on an actual CHANGE, never on mount: a timeline mounting into a tab
  // that peers are already synced on must adopt their window, not erase it.
  const lastPatientRef = useRef(patientId)
  useEffect(() => {
    if (lastPatientRef.current === patientId) return
    lastPatientRef.current = patientId
    forgetTimelineRange(channel)
  }, [patientId, channel])

  // Sync, canvas side. Dygraph broadcasts from its own drawCallback; the canvas
  // renderer has no such hook, so the two ends are wired here instead. Both
  // speak the same channel, so a Dygraph timeline and a mixed-shape one stay in
  // step with each other.
  const onCanvasViewChange = useCallback(
    (next: TimeWindow) => {
      setCanvasView(next)
      if (syncTimeRange) broadcastTimelineRange(channel, widgetId, { min: next.lo, max: next.hi })
    },
    [syncTimeRange, channel, widgetId],
  )

  useEffect(() => {
    if (renderer !== 'overview' || !syncTimeRange || !tabId) return
    const current = getTimelineRange(channel)
    if (current) setCanvasView({ lo: current.min, hi: current.max ?? current.min })
    // No ping-pong guard needed here: a peer's range lands through setCanvasView,
    // which does not go back through onCanvasViewChange, so nothing re-broadcasts.
    return subscribeTimelineSync(channel, (range, sourceId) => {
      if (sourceId === widgetId) return
      setCanvasView(range ? { lo: range.min, hi: range.max ?? range.min } : null)
    })
  }, [renderer, syncTimeRange, tabId, channel, widgetId])

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

    // If no data — or the canvas renderer is drawing instead — destroy the chart.
    if (renderer !== 'dygraphs' || !chartData || chartData.length === 0 || conceptNames.length === 0) {
      if (dygraphRef.current) {
        dygraphRef.current.destroy()
        dygraphRef.current = null
        gutterRef.current = null
      }
      return
    }

    const colors = getSeriesColors(conceptNames, conceptIdByName, conceptColors, conceptIds)
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
          // Dygraph's own formatter is 24-hour whatever the language, so the
          // same instant read "20:00" here and "8 PM" on a mixed-shape timeline
          // stacked above it. Both go through the shared formatter instead.
          axisLabelFormatter: ((value: number | Date, _granularity: number, _opts: unknown, g?: Dygraph) => {
            const ms = value instanceof Date ? value.getTime() : value
            // The graph is absent on the very first format pass; a short window
            // is the safer guess there, since it is what a fresh chart shows.
            const range = g?.xAxisRange?.()
            const span = range ? range[1] - range[0] : 0
            return formatAxisTick(ms, tickShowsClock(span), i18n.language)
          }) as unknown as dygraphs.Options['axisLabelFormatter'],
        },
        y: {
          axisLabelFontSize: 10,
          drawGrid: true,
          // Puts the plot exactly where the canvas renderer's starts, so two
          // stacked timelines line up in time whichever engine draws them.
          axisLabelWidth: dygraphAxisLabelWidth(gutter),
          ...(yAxisFromZero ? { includeZero: true } : {}),
        },
      },
      // The matching blank on the right, so the two plots also END together.
      rightGap: TIMELINE_PAD_R,

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
        broadcastTimelineRange(channel, widgetId, { min, max })
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

    // A changed gutter has to be rebuilt, not updated in place: `axisLabelWidth`
    // sizes the axis label divs dygraphs created, and updateOptions leaves the
    // old ones behind — the chart then shows both widths at once, one drawn over
    // the other.
    if (dygraphRef.current && gutterRef.current !== gutter) {
      dygraphRef.current.destroy()
      dygraphRef.current = null
    }
    gutterRef.current = gutter

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
    // `gutter`: Dygraph must re-lay-out when an overview starts or stops
    // leading one, or the alignment breaks exactly when it is wanted.
    // `i18n.language`: the axis formatter reads it, so the labels have to be
    // rebuilt on a language switch — 8 PM becomes 20:00.
    // conceptColors / conceptIds are covered by their serialized keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, chartData, conceptNames, conceptIdByName, getThemeColors, yAxisFromZero, stepPlot, showPoints, strokeWidth, syncTimeRange, conceptColorsKey, channel, gutter, i18n.language, widgetId])

  // Sync: when another timeline on this channel broadcasts a range, adopt it.
  useEffect(() => {
    if (!syncTimeRange || !tabId) return

    // Adopt the channel's current shared window once, when sync becomes active —
    // not on every data reload (which would snap a fresh chart to a stale one).
    const current = getTimelineRange(channel)
    if (current && dygraphRef.current) {
      dygraphRef.current.updateOptions({ dateWindow: [current.min, current.max ?? current.min] })
    }

    const unsubscribe = subscribeTimelineSync(channel, (range, sourceId) => {
      if (sourceId === widgetId) return
      const g = dygraphRef.current
      if (!g) return
      // Skip if we're already showing this window — stops the ping-pong where
      // applying a peer's range fires our own drawCallback and bounces back.
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
  }, [syncTimeRange, tabId, channel, widgetId])

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
        const colors = getSeriesColors(conceptNames, conceptIdByName, conceptColors, conceptIds)
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
        style={{
          visibility: overlayMessage || renderer !== 'dygraphs' ? 'hidden' : 'visible',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      />
      {/* The mixed-shape renderer, for a selection Dygraph cannot draw. Mounted
          only in that mode so its ResizeObserver doesn't run behind a dygraph. */}
      {!overlayMessage && renderer === 'overview' && (
        <div className="absolute inset-0">
          <TimelineCanvas
            series={series}
            bounds={bounds}
            view={view}
            onViewChange={onCanvasViewChange}
            locale={i18n.language}
            gutter={gutter}
          />
        </div>
      )}
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
              {t('patient_data.configure_widget')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
