import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { usePatientChartContext } from '../PatientChartContext'
import { useTabVisible } from '../TabVisibilityContext'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import {
  subscribeTimelineSync,
  broadcastTimelineRange,
  getTimelineRange,
  syncChannel,
  retractGutter,
} from '../timeline-sync'
import { overviewSupportsClasses, overviewUnitTableLabel } from '@/lib/duckdb/patient-overview-queries'
import { usePatientScope } from '../use-patient-scope'
import { useOverviewRecord } from './use-overview-record'
import { useOverviewData } from './use-overview-data'
import { OverviewDataCache } from './overview-tiles'
import { buildOverviewRows, type OverviewConceptRow, type OverviewRow } from './overview-layout'
import { CategoryMenu, ConceptCopyMenu, HoverTip, Message, type TipContent } from './overview-popups'
import { TABLE_PALETTE, FOOT, RANGE_H, clamp, setOffsetFromBar, describeHit } from './overview-helpers'
import { paintOverview } from './overview-paint'
import type { LayoutRow, BarHit, RangeGeom, DragState } from './overview-draw'

interface PatientOverviewWidgetProps {
  widgetId: string
  /** The config to render. The editor's preview passes its unsaved draft here, so
   *  reading the store instead would show the last saved state. */
  config?: Record<string, unknown>
}

/**
 * Patient data overview: every event the patient has, by source table and
 * concept — where the record holds data and where it holds none.
 *
 * The level of detail follows the zoom, per row: far out a row is a density
 * band, and once its events would no longer collide it becomes the events
 * themselves — a value line, blocks for anything with a duration, dots
 * otherwise. Density is aggregated in SQL, so a 400k-event ICU record ships a
 * few hundred numbers rather than every row.
 *
 * Everything is driven by the schema mapping, so the same widget runs on OMOP
 * CDM and MIMIC-IV without knowing either model's table names.
 */
export function PatientOverviewWidget({ widgetId, config }: PatientOverviewWidgetProps) {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const visible = useTabVisible()
  // Narrow selectors: see PatientSummaryWidget.
  const selectedPatientIds = usePatientChartStore((s) => s.selectedPatientId)
  const selectedVisitIds = usePatientChartStore((s) => s.selectedVisitId)
  const widgets = usePatientChartStore((s) => s.widgets)
  const selectedPatientId = selectedPatientIds[projectUid] ?? null
  const selectedVisitId = selectedVisitIds[projectUid] ?? null

  const widget = widgets.find((w) => w.id === widgetId)
  const cfg = (config ?? widget?.config ?? {}) as Record<string, unknown>

  const byClassSetting = cfg.groupByClass === true
  const showUnitStays = cfg.showUnitStays !== false
  const showDeath = cfg.showDeath !== false
  const showRange = cfg.showRangeSelector !== false
  const syncTimeRange = cfg.syncTimeRange === true
  const rowH = Number(cfg.rowHeight ?? 22) || 22

  const tabId = widget?.tabId ?? ''
  // The board owns the cross-tab setting; the tab is what ties this widget to it.
  const boardId = usePatientChartStore(
    (s) => s.tabs.find((tb) => tb.id === tabId)?.patientDashboardId,
  )
  const syncAcrossTabs = usePatientChartStore(
    (s) => s.dashboards.find((d) => d.id === boardId)?.syncTimelinesAcrossTabs ?? false,
  )
  const channel = syncChannel(tabId, boardId, syncAcrossTabs)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [view, setViewRaw] = useState<{ lo: number; hi: number } | null>(null)
  /** Hover tooltip: its content plus where the pointer was, in viewport coords. */
  const [tip, setTip] = useState<TipContent | null>(null)
  /** Right-click menu on a category, in viewport coordinates. */
  const [menu, setMenu] = useState<{ row: OverviewRow; x: number; y: number } | null>(null)
  const [copyMenu, setCopyMenu] = useState<
    { concept: OverviewConceptRow; x: number; y: number } | null
  >(null)

  /**
   * Every window change goes out on the sync channel.
   *
   * Wrapping the setter rather than editing each of the eight places that move
   * the view — zoom, pan, range drag, double-click, keyboard — is what keeps a
   * new gesture from silently forgetting to broadcast.
   *
   * `applyingSyncRef` stops the ping-pong: a window adopted from a peer must
   * not be sent straight back to it.
   */
  const applyingSyncRef = useRef(false)
  // Read through a ref so `setView` keeps ONE identity for the life of the
  // widget, the way the raw setter did. The gesture handlers below are
  // useCallbacks that capture it; rebuilding it whenever the channel changed
  // would leave them broadcasting on the channel the widget used to be on.
  const syncRef = useRef({ syncTimeRange, channel })
  useEffect(() => {
    syncRef.current = { syncTimeRange, channel }
  }, [syncTimeRange, channel])
  const setView = useCallback(
    (next: { lo: number; hi: number } | null) => {
      setViewRaw(next)
      const { syncTimeRange: on, channel: ch } = syncRef.current
      if (!on || applyingSyncRef.current) return
      broadcastTimelineRange(ch, widgetId, next ? { min: next.lo, max: next.hi } : null)
    },
    [widgetId],
  )

  // Stop leading the gutter when this overview goes away or turns sync off, so
  // the timelines fall back to their own width instead of following a chart
  // that is no longer on screen.
  useEffect(() => {
    if (!syncTimeRange || !tabId) return
    return () => retractGutter(tabId)
  }, [syncTimeRange, tabId])

  useEffect(() => {
    if (!syncTimeRange || !tabId) return
    const current = getTimelineRange(channel)
    if (current) setViewRaw({ lo: current.min, hi: current.max ?? current.min })
    return subscribeTimelineSync(channel, (range, sourceId) => {
      if (sourceId === widgetId) return
      applyingSyncRef.current = true
      try {
        setViewRaw(range ? { lo: range.min, hi: range.max ?? range.min } : null)
      } finally {
        applyingSyncRef.current = false
      }
    })
  }, [syncTimeRange, tabId, channel, widgetId])

  // Interaction state lives in refs: it changes on every mouse move and must not
  // re-render React, only repaint the canvas.
  const collapsedRef = useRef(new Set<string>())
  const hiddenRef = useRef(new Set<string>())
  const offsetsRef = useRef(new Map<string, number>())
  const layoutRef = useRef<LayoutRow[]>([])
  const barsRef = useRef<BarHit[]>([])
  const rangeRef = useRef<RangeGeom | null>(null)
  const dataRef = useRef(new OverviewDataCache())
  // The plot width the last paint used: the fetch must ask for the bucket width
  // the painter will look up, and only the painter knows the gutter (it follows
  // the row labels). Set from the paint, which re-runs the fetch when it changes.
  const [paintedPlotW, setPaintedPlotW] = useState(0)
  const dragRef = useRef<DragState | null>(null)
  /** Latches after the first paint failure, so the error is reported once. */
  const paintFailedRef = useRef(false)
  /** Bumped when a drag moves; repaints without rebuilding the row list. */
  const [, forceRepaint] = useState(0)
  /** Bumped when collapse/hide/scroll change, which DOES rebuild the rows. */
  const [structureVersion, setStructureVersion] = useState(0)
  const repaint = useCallback(() => forceRepaint((n) => n + 1), [])
  const rebuild = useCallback(() => setStructureVersion((n) => n + 1), [])

  const supportsClasses = schemaMapping ? overviewSupportsClasses(schemaMapping) : false
  const byClass = byClassSetting && supportsClasses
  const unitsTable = schemaMapping ? overviewUnitTableLabel(schemaMapping) : null

  // Selecting a hospitalisation, then a unit stay, scopes the figure to it
  // (see lib/duckdb/patient-scope.ts for why a stay is matched by time).
  const { scope, ready: scopeReady } = usePatientScope(projectUid, dataSourceId, schemaMapping)

  // --- Load the record ------------------------------------------------------

  const { concepts, units, death, bounds, loading, error, setError, overview } = useOverviewRecord({
    visible, scopeReady, dataSourceId, schemaMapping, selectedPatientId, selectedVisitId, scope,
    showUnitStays, showDeath, setViewRaw, paintFailedRef, dataRef,
  })
  // An aggregate row's dot has to name the concept it came from, which the row
  // itself does not know.
  const conceptsById = useMemo(
    () => new Map(concepts.map((c) => [c.conceptId, c])),
    [concepts],
  )

  // --- Rows -----------------------------------------------------------------

  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      // getBoundingClientRect, NOT clientWidth: the mouse handlers hit-test
      // against the canvas's own rect, and the two disagree by any border or
      // fractional layout — which shifts every tooltip off its target.
      const r = el.getBoundingClientRect()
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      // A hidden tab is display:none, so its widgets measure 0. Keeping the last
      // real size means returning to the tab needs no re-measure and no repaint.
      if (w === 0 || h === 0) return
      // Only set state on a real change: a ResizeObserver that re-sets an equal
      // size would re-render on every observed frame.
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
    // Mount-only: the wrapper is always rendered, so its ref is stable. Without
    // the empty deps this tore down and rebuilt the observer on every render —
    // and this component re-renders on every mouse move and every drag frame.
  }, [])

  // Both floors below round *up*, so on a short widget the rows would claim more
  // height than exists and the axis drew underneath the range strip. The range
  // selector is the affordance worth sacrificing: it is navigation, whereas the
  // rows are the data. Dropped only when keeping it would leave no room to draw.
  const MIN_ROWS = 4
  const roomWithRange = size.h - FOOT - RANGE_H
  const rangeFits = roomWithRange >= MIN_ROWS * rowH
  const drawRange = showRange && rangeFits
  const chartH = Math.max(60, size.h - FOOT - (drawRange ? RANGE_H : 0))
  const budget = Math.max(MIN_ROWS, Math.floor(chartH / rowH))

  // Collapse/hide/scroll live in refs so a drag doesn't re-render, but the row
  // list must be rebuilt when they change — this counter is the one piece of
  // that state React needs to see.
  const layout = useMemo(
    () =>
      buildOverviewRows({
        concepts,
        budget,
        byClass,
        hasUnits: showUnitStays && units.length > 0,
        unitsTable,
        collapsed: collapsedRef.current,
        hidden: hiddenRef.current,
        offsets: offsetsRef.current,
      }),
    // structureVersion looks unused to the linter, but it is exactly the point:
    // collapse/hide/scroll live in refs, and bumping it is how those mutations
    // ask for a rebuild. Dropping it would freeze the row list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [concepts, budget, byClass, showUnitStays, units.length, unitsTable, structureVersion],
  )

  useEffect(() => {
    offsetsRef.current = layout.offsets
  }, [layout])

  const tableColour = useMemo(() => {
    const tables = [...new Set(concepts.map((c) => c.table))]
    const map = new Map<string, string>()
    tables.forEach((tbl, i) => map.set(tbl, TABLE_PALETTE[i % TABLE_PALETTE.length]))
    return map
  }, [concepts])

  useOverviewData({
    visible, view, bounds, rows: layout.rows, hiddenRef, dataRef,
    dataSourceId, schemaMapping, selectedPatientId, scope, paintedPlotW, repaint,
  })

  // --- Paint ----------------------------------------------------------------

  // Deliberately dep-less: a canvas repaints on every render, and listing the
  // dozen values the drawing reads would only be a slower way to say "always".
  // The setError inside is latched by paintFailedRef, so it cannot spin.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !view || !bounds) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    // The grid renders widgets inside a Suspense with no error boundary, so a
    // throw here would blank the whole board rather than this one widget.
    try {
      paintOverview(ctx, cv, view, bounds, {
        size, layout, rowH, t, i18n, units, death, overview, tableColour, syncTimeRange, tabId, showDeath, drawRange, setPaintedPlotW, hiddenRef, collapsedRef, dataRef, layoutRef, barsRef, dragRef, rangeRef,
      })
    } catch (e) {
      // Reported once. This effect has no dependency array, so setting state on
      // every failed paint would spin: fail → render → fail → render.
      if (!paintFailedRef.current) {
        paintFailedRef.current = true
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  })

  // --- Interaction ----------------------------------------------------------

  const msAt = useCallback(
    (px: number) => {
      const l = layoutRef.current[0]
      if (!l || !view) return null
      const plotW = size.w - l.plotL - 10
      return view.lo + ((px - l.plotL) / plotW) * (view.hi - view.lo)
    },
    [view, size.w],
  )

  const panBy = useCallback(
    (frac: number) => {
      if (!view || !bounds) return
      const span = view.hi - view.lo
      const full = bounds.hi - bounds.lo
      // A pure fraction-of-span step stalls at high zoom: panning a one-day
      // window across a decade needs thousands of presses. The floor of 0.5% of
      // the record keeps long jumps reachable.
      const step = Math.max(Math.abs(span * frac), full * 0.005) * Math.sign(frac)
      const lo = clamp(view.lo + step, bounds.lo, bounds.hi - span)
      setView({ lo, hi: lo + span })
    },
    [view, bounds, setView],
  )

  const zoomBy = useCallback(
    (factor: number, centre: number) => {
      if (!view || !bounds) return
      const full = bounds.hi - bounds.lo
      const s = Math.min((view.hi - view.lo) * factor, full)
      let lo = centre - (centre - view.lo) * (s / (view.hi - view.lo))
      let hi = lo + s
      if (lo < bounds.lo) { lo = bounds.lo; hi = lo + s }
      if (hi > bounds.hi) { hi = bounds.hi; lo = hi - s }
      setView({ lo, hi })
    },
    [view, bounds, setView],
  )

  const hitRange = useCallback((px: number, py: number) => {
    const r = rangeRef.current
    if (!r) return null
    if (py < r.y0 || py > r.y1 || px < r.x0 - 6 || px > r.x1 + 6) return null
    const EDGE = 5
    if (Math.abs(px - r.win.x0) <= EDGE) return 'lo' as const
    if (Math.abs(px - r.win.x1) <= EDGE) return 'hi' as const
    if (px > r.win.x0 && px < r.win.x1) return 'move' as const
    return 'jump' as const
  }, [])

  /**
   * Scroll the concept window of whichever group sits at this height. Returns
   * false when that row has nothing to scroll, so the caller can fall through.
   */
  const scrollGroupAt = useCallback(
    (py: number, deltaY: number) => {
      const hit = layoutRef.current.find((row) => py >= row.y && py < row.y + row.rowH)
      if (!hit) return false
      const win = layout.windows.get(hit.row.key)
      if (!win || win.total <= win.shown) return false
      const cur = offsetsRef.current.get(hit.row.key) ?? 0
      const next = clamp(cur + (deltaY > 0 ? 1 : -1), 0, win.total - win.shown)
      if (next === cur) return true
      offsetsRef.current.set(hit.row.key, next)
      rebuild()
      return true
    },
    [layout, rebuild],
  )

  const onWheel = useCallback(
    (e: WheelEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const l = layoutRef.current
      if (!l.length || !view) return

      // Over the labels: scroll THAT group's concept window.
      if (px < l[0].plotL) {
        if (scrollGroupAt(py, e.deltaY)) e.preventDefault()
        return
      }

      if (hitRange(px, py)) {
        e.preventDefault()
        panBy(e.deltaY > 0 ? 0.15 : -0.15)
        return
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        panBy((e.shiftKey ? e.deltaY : e.deltaX) > 0 ? 0.15 : -0.15)
        return
      }
      // Over the plot a plain wheel scrolls the row under the pointer, exactly
      // as it does in the gutter beside it — the two halves of a row are one
      // thing, and zooming on scroll fought every attempt to reach a concept
      // further down the group. Zoom keeps the modifier, as maps do. A row with
      // nothing to scroll leaves the wheel to the page.
      if (!e.ctrlKey && !e.metaKey) {
        if (scrollGroupAt(py, e.deltaY)) e.preventDefault()
        return
      }
      // Ctrl+wheel is also what a trackpad pinch emits; without this the
      // browser zooms the whole page along with the chart.
      e.preventDefault()
      const centre = msAt(px)
      if (centre != null) zoomBy(e.deltaY > 0 ? 1.25 : 0.8, centre)
    },
    [view, msAt, zoomBy, panBy, hitRange, scrollGroupAt],
  )

  const onWheelRef = useRef(onWheel)
  useEffect(() => {
    onWheelRef.current = onWheel
  }, [onWheel])

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top

      const rangeHit = hitRange(px, py)
      if (rangeHit && rangeRef.current && view && bounds) {
        e.preventDefault()
        if (rangeHit === 'jump') {
          const r = rangeRef.current
          const span = view.hi - view.lo
          const frac = clamp((px - r.x0) / (r.x1 - r.x0), 0, 1)
          const lo = clamp(bounds.lo + frac * (bounds.hi - bounds.lo) - span / 2, bounds.lo, bounds.hi - span)
          setView({ lo, hi: lo + span })
          dragRef.current = { kind: 'range', mode: 'move', grab: (r.win.x1 - r.win.x0) / 2 }
        } else {
          dragRef.current = { kind: 'range', mode: rangeHit, grab: px - rangeRef.current.win.x0 }
        }
        return
      }

      const bar = barsRef.current.find(
        (b) => px >= b.x0 && px <= b.x1 && py >= b.trackY && py <= b.trackY + b.trackH,
      )
      if (bar) {
        e.preventDefault()
        const onThumb = py >= bar.thumbY && py <= bar.thumbY + bar.thumbH
        if (!onThumb) {
          setOffsetFromBar(bar, py - bar.thumbH / 2, offsetsRef.current)
          rebuild()
        }
        dragRef.current = { kind: 'bar', bar, grab: onThumb ? py - bar.thumbY : bar.thumbH / 2 }
        return
      }

      const l = layoutRef.current
      if (!l.length || px < l[0].plotL) return
      dragRef.current = { kind: 'zoom', x0: px, x1: px, moved: false }
    },
    [hitRange, view, bounds, rebuild, setView],
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const d = dragRef.current

      if (d?.kind === 'range' && rangeRef.current && view && bounds) {
        const r = rangeRef.current
        const frac = (p: number) => clamp((p - r.x0) / (r.x1 - r.x0), 0, 1)
        const at = (p: number) => bounds.lo + frac(p) * (bounds.hi - bounds.lo)
        const MIN = 60_000
        if (d.mode === 'move') {
          const span = view.hi - view.lo
          const lo = clamp(at(px - d.grab), bounds.lo, bounds.hi - span)
          setView({ lo, hi: lo + span })
        } else if (d.mode === 'lo') {
          setView({ lo: clamp(at(px), bounds.lo, view.hi - MIN), hi: view.hi })
        } else {
          setView({ lo: view.lo, hi: clamp(at(px), view.lo + MIN, bounds.hi) })
        }
        return
      }

      if (d?.kind === 'bar') {
        setOffsetFromBar(d.bar, py - d.grab, offsetsRef.current)
        rebuild()
        return
      }

      if (d?.kind === 'zoom') {
        d.x1 = px
        d.moved = Math.abs(d.x1 - d.x0) > 3
        repaint()
        return
      }

      const cv = e.currentTarget
      const rangeHit = hitRange(px, py)
      const l = layoutRef.current
      const hit = l.find((r) => py >= r.y && py < r.y + r.rowH)
      const inGutter = l.length > 0 && px < l[0].plotL
      const foldable = !!hit && (hit.row.kind === 'table' || hit.row.kind === 'class')

      // The pointer marks what is actionable: a category folds on click and
      // opens a menu on right-click, so it earns the hand.
      cv.style.cursor = rangeHit
        ? rangeHit === 'lo' || rangeHit === 'hi'
          ? 'ew-resize'
          : rangeHit === 'move'
            ? 'grab'
            : 'pointer'
        : inGutter
          ? foldable
            ? 'pointer'
            : 'default'
          : 'crosshair'

      if (rangeHit || !hit || !view) {
        setTip(null)
        return
      }
      const content = describeHit(hit, px, py, inGutter, view, t, conceptsById)
      setTip(content ? { ...content, x: e.clientX, y: e.clientY } : null)
    },
    [view, bounds, hitRange, repaint, rebuild, t, conceptsById, setView],
  )

  const onMouseUp = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.kind === 'zoom' && d.moved) {
      const a = msAt(Math.min(d.x0, d.x1))
      const b = msAt(Math.max(d.x0, d.x1))
      if (a != null && b != null && b - a > 1000) setView({ lo: a, hi: b })
    }
    repaint()
  }, [msAt, repaint, setView])

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const l = layoutRef.current
      if (!l.length || px >= l[0].plotL) return
      const hit = l.find((row) => py >= row.y && py < row.y + row.rowH)
      if (!hit) return
      const key =
        hit.row.kind === 'class' ? hit.row.key : hit.row.kind === 'table' ? hit.row.table : null
      if (!key) return
      const set = collapsedRef.current
      if (set.has(key)) set.delete(key)
      else set.add(key)
      rebuild()
    },
    [rebuild],
  )

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const l = layoutRef.current
      if (!l.length) return
      const hit = l.find((r) => py >= r.y && py < r.y + r.rowH)
      if (!hit || hit.row.kind === 'units') return

      // Over the plot, the menu is about the concept under the cursor rather
      // than the category: identifiers are what you want to carry elsewhere.
      if (px >= l[0].plotL) {
        const mark = hit.marks?.find((m) => px >= m.x0 && px <= m.x1 && py >= m.y0 && py <= m.y1)
        const id = mark?.event?.conceptId ?? (hit.row.mixed ? null : hit.row.conceptIds[0])
        const c = id ? conceptsById.get(String(id)) : undefined
        if (!c) return
        e.preventDefault()
        setTip(null)
        setMenu(null)
        setCopyMenu({ concept: c, x: e.clientX, y: e.clientY })
        return
      }

      // Right-clicking a concept acts on the category it belongs to, so the
      // menu never misses when the cursor is a row or two off.
      e.preventDefault()
      setTip(null)
      setCopyMenu(null)
      setMenu({ row: hit.row, x: e.clientX, y: e.clientY })
    },
    [conceptsById],
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const l = layoutRef.current
      // Only from the plot: in the gutter a double-click is two folds.
      if (l.length && px < l[0].plotL) return
      if (bounds) setView(bounds)
    },
    [bounds, setView],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 0.5 : 0.15
      if (e.key === 'ArrowLeft') { e.preventDefault(); panBy(-step) }
      if (e.key === 'ArrowRight') { e.preventDefault(); panBy(step) }
      if (e.key === '0' && bounds) { e.preventDefault(); setView(bounds) }
      if ((e.key === '+' || e.key === '=') && view) {
        e.preventDefault()
        zoomBy(0.8, (view.lo + view.hi) / 2)
      }
      if (e.key === '-' && view) {
        e.preventDefault()
        zoomBy(1.25, (view.lo + view.hi) / 2)
      }
    },
    [panBy, zoomBy, bounds, view, setView],
  )

  // --- Render ---------------------------------------------------------------

  const message = !selectedPatientId
    ? t('patient_data.select_patient_first')
    : error
      ? error
      : loading && concepts.length === 0
        ? t('patient_data.overview_loading')
        : !loading && concepts.length === 0
          ? t('patient_data.overview_no_data')
          : null

  const hasCanvas = !message
  useEffect(() => {
    const canvas = canvasRef.current
    if (!hasCanvas || !canvas) return
    // React registers wheel listeners as passive, where preventDefault is ignored.
    const listener = (e: WheelEvent) => onWheelRef.current(e)
    canvas.addEventListener('wheel', listener, { passive: false })
    return () => canvas.removeEventListener('wheel', listener)
  }, [hasCanvas])

  // The wrapper is ALWAYS rendered, even for the messages: it carries the ref
  // the ResizeObserver attaches to on mount. Returning a bare message instead
  // left that ref null, so the observer never attached and the canvas kept a
  // size of 0×0 once the data arrived — a permanently blank widget.
  //
  // The canvas is positioned but NOT stretched by CSS: the paint sets its
  // width/height in CSS pixels to match exactly what it draws. Sizing it with
  // `inset-0`/`w-full` instead scales the drawing whenever the measured size
  // lags a frame behind the box, which moves every mark away from the pointer
  // hit-testing it — tooltips then land on the wrong row, or on nothing.
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      {message ? (
        <Message text={message} tone={error ? 'error' : undefined} />
      ) : (
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="absolute left-0 top-0 block outline-none"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => {
            onMouseUp()
            setTip(null)
          }}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
        />
      )}
      {tip && <HoverTip tip={tip} />}
      {menu && (
        <CategoryMenu
          row={menu.row}
          x={menu.x}
          y={menu.y}
          rows={layout.rows}
          collapsed={collapsedRef.current}
          hidden={hiddenRef.current}
          onClose={() => setMenu(null)}
          onChanged={rebuild}
          t={t}
        />
      )}
      {copyMenu && (
        <ConceptCopyMenu
          concept={copyMenu.concept}
          x={copyMenu.x}
          y={copyMenu.y}
          onClose={() => setCopyMenu(null)}
          t={t}
        />
      )}
    </div>
  )
}
