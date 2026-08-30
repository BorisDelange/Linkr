import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePatientChartContext } from '../PatientChartContext'
import { useTabVisible } from '../TabVisibilityContext'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import {
  subscribeTimelineSync,
  broadcastTimelineRange,
  getTimelineRange,
  syncChannel,
  publishGutter,
  retractGutter,
} from '../timeline-sync'
import { sameBounds } from './timeline-view'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildOverviewInventoryQuery,
  buildOverviewUnitStaysQuery,
  buildOverviewDeathQuery,
  buildOverviewEventsQuery,
  buildOverviewDensityQuery,
  buildOverviewStayWindowQuery,
  overviewSupportsClasses,
  overviewUnitTableLabel,
  type OverviewStayWindow,
} from '@/lib/duckdb/patient-overview-queries'
import {
  buildOverviewRows,
  medianGapPx,
  MIN_GAP_PX,
  FEW_EVENTS,
  shortenDrugName,
  looksLikeDrugName,
  sameWords,
  hourlyRate,
  unitIsRate,
  type OverviewConceptRow,
  type OverviewRow,
} from './overview-layout'
import { toMs } from '@/lib/duckdb/value-coercion'
import { drawEventRow, shade, type OverviewEvent, type Mark as EventMark } from './event-marks'
import { fmtValue, fmtDuration as fmtDur, fmtStamp } from './event-format'

interface PatientOverviewWidgetProps {
  widgetId: string
  /** The config to render. The editor's preview passes its unsaved draft here, so
   *  reading the store instead would show the last saved state. */
  config?: Record<string, unknown>
}

interface UnitStay {
  start: number
  end: number | null
  name: string
  category: string | null
}


/** Whole-record density for the range selector's background. */
interface OverviewDensity {
  counts: Float64Array
  max: number
}

/** Buckets in the range selector's histogram — enough for a smooth strip. */
const RANGE_BUCKETS = 240


/** Per-source-table colours, assigned by position so any schema gets a palette. */
const TABLE_PALETTE = [
  '#2563eb', '#7c3aed', '#0891b2', '#dc2626',
  '#db2777', '#ea580c', '#16a34a', '#0f766e',
]
const UNIT_PALETTE = ['#0f766e', '#7c3aed', '#b45309', '#be123c', '#1d4ed8', '#4d7c0f', '#a21caf', '#0369a1']

/** Events fetched per row before the row falls back to a density band. */
const EVENT_FETCH_LIMIT = 4000

const FOOT = 30
const RANGE_H = 46
const GUTTER_MAX = 320

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))


function stableColour(name: string, palette: string[]): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
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
  const selectedVisitDetailIds = usePatientChartStore((s) => s.selectedVisitDetailId)
  const selectedPatientId = selectedPatientIds[projectUid] ?? null
  const selectedVisitId = selectedVisitIds[projectUid] ?? null
  const selectedVisitDetailId = selectedVisitDetailIds[projectUid] ?? null

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

  const [concepts, setConcepts] = useState<OverviewConceptRow[]>([])
  // An aggregate row's dot has to name the concept it came from, which the row
  // itself does not know.
  const conceptsById = useMemo(
    () => new Map(concepts.map((c) => [c.conceptId, c])),
    [concepts],
  )
  const [units, setUnits] = useState<UnitStay[]>([])
  const [death, setDeath] = useState<number | null>(null)
  const [bounds, setBounds] = useState<{ lo: number; hi: number } | null>(null)
  /** The bounds of the record currently loaded, read during the load itself —
   *  where the `bounds` state is still the previous render's value. */
  const boundsRef = useRef<{ lo: number; hi: number } | null>(null)
  const [view, setViewRaw] = useState<{ lo: number; hi: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<OverviewDensity | null>(null)
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
  const eventsRef = useRef(new Map<string, OverviewEvent[]>())
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

  /**
   * Selecting a unit stay scopes the figure to that stay's time window.
   *
   * By time rather than by foreign key: OMOP's `visit_detail_id` is NULL on
   * every event row of the sample warehouse, and MIMIC's `labevents` has no
   * stay column at all — an FK filter would empty the widget on both. The
   * window is fetched by id so the scope survives a reload.
   */
  const [stayWindow, setStayWindow] = useState<OverviewStayWindow | null>(null)
  useEffect(() => {
    if (!selectedVisitDetailId || !dataSourceId || !schemaMapping) {
      setStayWindow(null)
      return
    }
    let cancelled = false
    const sql = buildOverviewStayWindowQuery(schemaMapping, selectedVisitDetailId)
    if (!sql) {
      setStayWindow(null)
      return
    }
    void queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (cancelled) return
        const r = rows[0]
        const start = r ? toMs(r.stay_start) : null
        if (start == null) {
          setStayWindow(null)
          return
        }
        const end = r ? toMs(r.stay_end) : null
        setStayWindow({ start: new Date(start).toISOString(), end: end == null ? null : new Date(end).toISOString() })
      })
      .catch(() => {
        if (!cancelled) setStayWindow(null)
      })
    return () => {
      cancelled = true
    }
  }, [selectedVisitDetailId, dataSourceId, schemaMapping])

  // --- Load the record ------------------------------------------------------

  useEffect(() => {
    if (!visible) return
    if (!dataSourceId || !schemaMapping || !selectedPatientId) {
      setConcepts([])
      setUnits([])
      setDeath(null)
      boundsRef.current = null
      setBounds(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    paintFailedRef.current = false
    eventsRef.current.clear()

    /**
     * The range selector's background: the whole record in one histogram,
     * aggregated in SQL. One query for every table at once, so it costs the same
     * whether the patient has 80k events or 400k.
     */
    const loadOverviewDensity = async (
      b: { lo: number; hi: number },
      rows: OverviewConceptRow[],
    ) => {
      const byTable = new Map<string, string[]>()
      for (const r of rows) {
        const list = byTable.get(r.table)
        if (list) list.push(r.conceptId)
        else byTable.set(r.table, [r.conceptId])
      }
      const bands = [...byTable].map(([table, conceptIds]) => ({ key: table, table, conceptIds }))
      const from = isoOrNull(b.lo)
      const to = isoOrNull(b.hi)
      if (!from || !to || bands.length === 0) return
      const sql = buildOverviewDensityQuery(
        schemaMapping, selectedPatientId, selectedVisitId, from, to, RANGE_BUCKETS, bands, stayWindow,
      )
      if (!sql) return
      try {
        const raw = await queryDataSource(dataSourceId, sql)
        if (cancelled) return
        const counts = new Float64Array(RANGE_BUCKETS)
        let max = 0
        for (const r of raw) {
          const i = Number(r.bucket)
          if (!Number.isFinite(i) || i < 0 || i >= RANGE_BUCKETS) continue
          counts[i] += Number(r.n ?? 0)
          if (counts[i] > max) max = counts[i]
        }
        setOverview({ counts, max })
      } catch {
        // The strip simply stays empty; it is navigation aid, not data.
        setOverview(null)
      }
    }

    const run = async () => {
      try {
        const invSql = buildOverviewInventoryQuery(
          schemaMapping, selectedPatientId, selectedVisitId, stayWindow,
        )
        const inv = invSql ? await queryDataSource(dataSourceId, invSql) : []
        if (cancelled) return

        const rows: OverviewConceptRow[] = inv.map((r) => ({
          table: String(r.table_label),
          conceptId: String(r.concept_id),
          conceptName: String(r.concept_name ?? r.concept_id),
          conceptCode: r.concept_code == null ? null : String(r.concept_code),
          conceptClass: r.concept_class == null ? null : String(r.concept_class),
          unit: r.unit == null ? null : String(r.unit),
          unitCount: Number(r.unit_count ?? 0),
          eventCount: Number(r.event_count ?? 0),
          durational: r.durational === true || r.durational === 'true',
        }))

        let lo = Infinity
        let hi = -Infinity
        for (const r of inv) {
          const a = toMs(r.first_event)
          const b = toMs(r.last_event)
          if (a != null && a < lo) lo = a
          if (b != null && b > hi) hi = b
        }

        let stays: UnitStay[] = []
        if (showUnitStays) {
          const sql = buildOverviewUnitStaysQuery(schemaMapping, selectedPatientId, selectedVisitId)
          if (sql) {
            const raw = await queryDataSource(dataSourceId, sql)
            if (cancelled) return
            stays = raw
              .map((r) => ({
                start: toMs(r.stay_start) ?? 0,
                end: toMs(r.stay_end),
                name: String(r.unit_name ?? ''),
                category: r.unit_category == null ? null : String(r.unit_category),
              }))
              .filter((s) => s.start > 0)
            for (const s of stays) {
              if (s.start < lo) lo = s.start
              const e = s.end ?? s.start
              if (e > hi) hi = e
            }
          }
        }

        let deathMs: number | null = null
        if (showDeath) {
          const sql = buildOverviewDeathQuery(schemaMapping, selectedPatientId)
          if (sql) {
            const raw = await queryDataSource(dataSourceId, sql)
            if (cancelled) return
            deathMs = raw.length ? toMs(raw[0].death_date) : null
            if (deathMs != null) {
              if (deathMs < lo) lo = deathMs
              if (deathMs > hi) hi = deathMs
            }
          }
        }

        if (cancelled) return
        setConcepts(rows)
        setUnits(stays)
        setDeath(deathMs)
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          const pad = (hi - lo) * 0.01 || 86_400_000
          const b = { lo: lo - pad, hi: hi + pad }
          const sameRecord = sameBounds(boundsRef.current, b)
          boundsRef.current = b
          setBounds(b)
          // Frame the record only when the window does not already belong to it.
          // This effect re-runs whenever the tab becomes visible again, and
          // reframing there threw away whatever the user had zoomed to. Bounds
          // identify the record: a different patient or visit gives different
          // ones and still resets.
          //
          // setViewRaw, not setView: this is the widget framing itself, not a
          // gesture. Broadcasting it would yank every synced peer back to full
          // extent each time this one reloads.
          setViewRaw((prev) => (prev && sameRecord ? prev : b))
          void loadOverviewDensity(b, rows)
        } else {
          boundsRef.current = null
          setBounds(null)
          setViewRaw(null)
          setOverview(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [visible, dataSourceId, schemaMapping, selectedPatientId, selectedVisitId, stayWindow, showUnitStays, showDeath])

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

  // --- Fetch events for rows that are drawn individually --------------------

  useEffect(() => {
    if (!visible || !view || !bounds || !dataSourceId || !schemaMapping || !selectedPatientId) return
    const plotW = Math.max(120, size.w - 160)
    let cancelled = false

    const wanted = layout.rows.filter((row) => {
      if (row.kind === 'units' || row.conceptIds.length === 0) return false
      if (hiddenRef.current.has(row.table) || hiddenRef.current.has(row.key)) return false
      // Scale the whole-record count down to the visible slice: eventCount spans
      // the entire stay and never changes with zoom, so testing it directly locks
      // every busy row — a vital sign sampled hourly — into a density band at
      // EVERY zoom level. LIMIT caps the cost of being wrong here.
      const recordSpan = Math.max(1, bounds.hi - bounds.lo)
      const inView = row.eventCount * ((view.hi - view.lo) / recordSpan)
      const ok = inView / plotW < 1.5
      return ok
    })

    // A non-finite bound would make toISOString throw, which blanks the whole
    // board rather than just this widget.
    const fromIso = isoOrNull(view.lo)
    const toIso = isoOrNull(view.hi)
    if (!fromIso || !toIso) return

    const run = async () => {
      for (const row of wanted) {
        const key = eventKey(row, view)
        if (eventsRef.current.has(key)) continue
        const build = (omitValueString: boolean) =>
          buildOverviewEventsQuery(
            schemaMapping,
            selectedPatientId,
            selectedVisitId,
            row.table,
            row.conceptIds,
            fromIso,
            toIso,
            EVENT_FETCH_LIMIT,
            stayWindow,
            omitValueString,
          )
        const sql = build(false)
        if (!sql) continue
        try {
          let raw: Record<string, unknown>[]
          try {
            raw = await queryDataSource(dataSourceId, sql)
          } catch (err) {
            // A stale mapping can name a value column the table lacks. Retry
            // without it: the events still draw, only the text tooltip is lost.
            const retry = build(true)
            if (!retry || retry === sql) throw err
            raw = await queryDataSource(dataSourceId, retry)
          }
          if (cancelled) return
          eventsRef.current.set(
            key,
            raw.map((r) => ({
              start: toMs(r.event_start) ?? 0,
              end: toMs(r.event_end),
              value: r.value_number == null ? null : Number(r.value_number),
              text: r.value_string == null ? null : String(r.value_string),
              conceptId: r.concept_id == null ? null : String(r.concept_id),
              route: r.route == null ? null : String(r.route),
            })),
          )
          repaint()
        } catch (err) {
          // A row that fails to load falls back to a density band — which looks
          // exactly like a row that was aggregated on purpose. Staying silent
          // here hid a broken column behind a plausible-looking figure, so the
          // failure is always reported even though it is not fatal.
          console.warn('[patient-overview] events query failed for', row.label, err)
          eventsRef.current.set(key, [])
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [visible, view, bounds, layout, dataSourceId, schemaMapping, selectedPatientId, selectedVisitId, stayWindow, size.w, repaint])

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
      paint(ctx, cv, view, bounds)
    } catch (e) {
      // Reported once. This effect has no dependency array, so setting state on
      // every failed paint would spin: fail → render → fail → render.
      if (!paintFailedRef.current) {
        paintFailedRef.current = true
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    return

    function paint(
      ctx: CanvasRenderingContext2D,
      cv: HTMLCanvasElement,
      view: { lo: number; hi: number },
      bounds: { lo: number; hi: number },
    ) {
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const w = size.w
    const rows = layout.rows
    // Exactly the wrapper's box. The canvas is stretched to it by CSS
    // (absolute inset-0), so drawing at any other size would scale every pixel
    // and put the marks somewhere other than where the mouse reports them.
    const h = size.h
    if (w < 80 || h < 40) return

    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    // Pin the CSS size too: without it the intrinsic size and the stretched box
    // can disagree, which is exactly what offsets the hit-testing.
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const labelFont = `${Math.min(12, rowH - 6)}px Inter, system-ui`
    const headerFont = `600 ${Math.min(11, rowH - 7)}px Inter, system-ui`
    const metaFont = `${Math.min(10, rowH - 8)}px Inter, system-ui`

    const label = (row: OverviewRow) => rowLabel(row, t)
    const rightText = (row: OverviewRow) =>
      row.kind === 'table' || row.kind === 'units' || row.kind === 'class'
        ? `${fmtN(row.kind === 'units' ? unitCount(units) : row.conceptCount)} ${
            row.kind === 'units' ? t('patient_data.overview_units') : t('patient_data.overview_concepts')
          } · ${fmtN(row.eventCount)}`
        : fmtN(row.eventCount)

    ctx.font = labelFont
    let labelW = 0
    for (const r of rows) labelW = Math.max(labelW, ctx.measureText(label(r)).width)
    ctx.font = metaFont
    let countW = 0
    for (const r of rows) countW = Math.max(countW, ctx.measureText(rightText(r)).width)

    const GAP = 10
    const gutter = Math.min(GUTTER_MAX, 26 + labelW + GAP + countW + GAP)
    const truncateTo = Math.max(40, gutter - 8 - GAP - countW - GAP)
    const plotL = gutter
    const plotW = Math.max(40, w - plotL - 10)
    // Published so synced timelines on this tab can widen to the same origin.
    // Only while synced: a lone overview has no reason to reshape anything, and
    // this gutter follows its own labels, which change as rows fold and unfold.
    if (syncTimeRange) publishGutter(tabId, plotL)
    const lo = view.lo
    const span = view.hi - view.lo || 1
    const x = (ms: number) => plotL + ((ms - lo) / span) * plotW
    const nb = Math.max(40, Math.floor(plotW))

    const nested = rows.some((r) => r.kind === 'class')
    const newLayout: LayoutRow[] = []

    rows.forEach((row, i) => {
      const y = i * rowH
      if (i % 2) {
        ctx.fillStyle = 'rgba(148,163,184,0.07)'
        ctx.fillRect(plotL, y, plotW, rowH)
      }

      const isUnits = row.kind === 'units'
      const isHeader = row.kind === 'table' || isUnits
      const isClass = row.kind === 'class'
      const muted = hiddenRef.current.has(row.table) || hiddenRef.current.has(row.key)
      const colour = tableColour.get(row.table) ?? '#64748b'

      // A class row carries its own chevron at x=24, so its text must clear it;
      // concepts under a class indent one step further again.
      const indent = isHeader ? 22 : isClass ? 34 : nested ? 40 : 24

      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.font = isHeader || isClass ? headerFont : labelFont

      let text = isHeader && !isUnits ? label(row).toUpperCase() : label(row)
      if (isUnits) text = text.toUpperCase()
      const room = truncateTo - (indent - 8)
      let clipped = false
      if (ctx.measureText(text).width > room) {
        while (text.length > 1 && ctx.measureText(`${text}…`).width > room) text = text.slice(0, -1)
        text += '…'
        clipped = true
      }

      if (isUnits) {
        ctx.fillStyle = muted ? '#cbd5e1' : '#0f172a'
      } else if (isHeader || isClass) {
        const cx = isClass ? 24 : 12
        const cy = y + rowH / 2
        const r = isClass ? 3 : 3.5
        const shut = collapsedRef.current.has(isClass ? row.key : row.table)
        ctx.fillStyle = muted ? '#e2e8f0' : isClass ? '#94a3b8' : '#64748b'
        ctx.beginPath()
        if (shut) {
          ctx.moveTo(cx - r, cy - r - 1)
          ctx.lineTo(cx + r, cy)
          ctx.lineTo(cx - r, cy + r + 1)
        } else {
          ctx.moveTo(cx - r - 1, cy - r)
          ctx.lineTo(cx + r + 1, cy - r)
          ctx.lineTo(cx, cy + r)
        }
        ctx.closePath()
        ctx.fill()
        ctx.fillStyle = muted ? '#cbd5e1' : isClass ? '#475569' : colour
      } else {
        const stemX = nested ? 32 : 16
        ctx.strokeStyle = '#cbd5e1'
        ctx.beginPath()
        ctx.moveTo(stemX, y)
        ctx.lineTo(stemX, y + rowH / 2)
        ctx.lineTo(stemX + 5, y + rowH / 2)
        ctx.stroke()
        ctx.fillStyle = muted ? '#cbd5e1' : row.kind === 'other' ? '#94a3b8' : '#334155'
      }
      ctx.fillText(text, indent, y + rowH / 2)

      ctx.font = metaFont
      ctx.textAlign = 'right'
      ctx.fillStyle = muted ? '#e2e8f0' : isHeader ? '#64748b' : '#94a3b8'
      ctx.fillText(rightText(row), gutter - GAP, y + rowH / 2)

      ctx.save()
      ctx.beginPath()
      ctx.rect(plotL, y, plotW, rowH)
      ctx.clip()

      let marks: Mark[] | null = null
      let counts: Float64Array | null = null
      let level: 'density' | 'events' = 'density'

      if (isUnits) {
        marks = drawUnits(ctx, units, y, rowH, plotL, plotW, x, muted)
        level = 'events'
      } else if (!muted) {
        const key = eventKey(row, view)
        const evts = eventsRef.current.get(key)
        const inView = evts?.filter((e) => (e.end ?? e.start) >= lo && e.start <= view.hi) ?? null

        if (inView && inView.length < EVENT_FETCH_LIMIT && fitsIndividually(inView, plotW, span)) {
          marks = drawEventRow({
            ctx,
            events: inView,
            mixed: row.mixed,
            y,
            rowH,
            plotL,
            plotW,
            x,
            colour,
          })
          level = 'events'
        } else {
          counts = drawDensity(ctx, evts, y, rowH, plotL, nb, plotW / nb, lo, span, colour)
        }
      }
      ctx.restore()

      newLayout.push({ y, rowH, row, marks, counts, level, nb, bw: plotW / nb, plotL, clipped })
    })

    layoutRef.current = newLayout

    // Per-group scrollbars, in the gutter's left margin.
    const bands = new Map<string, { top: number; bottom: number; table: string }>()
    for (const l of newLayout) {
      if (l.row.kind !== 'concept' && l.row.kind !== 'other') continue
      const b = bands.get(l.row.key) ?? { top: l.y, bottom: l.y + l.rowH, table: l.row.table }
      b.top = Math.min(b.top, l.y)
      b.bottom = Math.max(b.bottom, l.y + l.rowH)
      bands.set(l.row.key, b)
    }
    const bars: BarHit[] = []
    for (const [key, b] of bands) {
      const win = layout.windows.get(key)
      if (!win || win.total <= win.shown) continue
      const off = layout.offsets.get(key) ?? 0
      const trackX = nested ? 15 : 3
      const trackW = 3
      const trackY = b.top + 1
      const trackH = Math.max(8, b.bottom - b.top - 2)
      ctx.fillStyle = '#e2e8f0'
      ctx.fillRect(trackX, trackY, trackW, trackH)
      const thumbH = Math.max(10, trackH * (win.shown / win.total))
      const thumbY = trackY + (trackH - thumbH) * (off / Math.max(1, win.total - win.shown))
      ctx.fillStyle = tableColour.get(b.table) ?? '#94a3b8'
      ctx.fillRect(trackX, thumbY, trackW, thumbH)
      bars.push({
        key,
        trackY,
        trackH,
        thumbY,
        thumbH,
        x0: trackX - 4,
        x1: trackX + trackW + 5,
        max: win.total - win.shown,
      })
    }
    barsRef.current = bars

    const bodyH = rows.length * rowH

    // Death: a badge rather than bare text, so it can't be read as part of
    // whatever row it crosses.
    if (showDeath && death != null && death >= lo && death <= view.hi) {
      const dx = x(death)
      ctx.save()
      ctx.strokeStyle = '#dc2626'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(dx, 0)
      ctx.lineTo(dx, bodyH)
      ctx.stroke()
      ctx.restore()

      const badge = t('patient_data.overview_death')
      ctx.font = '600 10px Inter, system-ui'
      const tw = ctx.measureText(badge).width
      const bw = tw + 10
      const bh = 15
      const right = dx + 4 + bw > w - 10
      const bx = right ? dx - 4 - bw : dx + 4
      ctx.fillStyle = '#dc2626'
      roundRect(ctx, bx, 2, bw, bh, 4)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(badge, bx + 5, 2 + bh / 2 + 0.5)
    }

    // Time axis
    const axisY = bodyH
    ctx.strokeStyle = '#e2e8f0'
    ctx.beginPath()
    ctx.moveTo(plotL, axisY + 0.5)
    ctx.lineTo(w - 10, axisY + 0.5)
    ctx.stroke()
    ctx.fillStyle = '#64748b'
    ctx.font = '10px Inter, system-ui'
    ctx.textBaseline = 'top'
    const ticks = Math.max(2, Math.min(7, Math.floor(plotW / 110)))
    const withClock = span < 3 * 86_400_000
    // The reader's own language, NOT a hardcoded region: en-GB is a 24-hour
    // locale, so it showed 22:34 where the timelines beside it showed 10:34 PM.
    const locale = i18n.language
    for (let k = 0; k <= ticks; k++) {
      const ms = lo + (span * k) / ticks
      ctx.textAlign = k === 0 ? 'left' : k === ticks ? 'right' : 'center'
      ctx.fillText(fmtAxis(ms, withClock, locale), clamp(x(ms), plotL, w - 10), axisY + 8)
    }

    // Drag-to-zoom overlay
    const d = dragRef.current
    if (d?.kind === 'zoom' && d.moved) {
      ctx.fillStyle = 'rgba(37,99,235,.15)'
      ctx.strokeStyle = 'rgba(37,99,235,.6)'
      const a = Math.min(d.x0, d.x1)
      const b = Math.max(d.x0, d.x1)
      ctx.fillRect(a, 0, b - a, bodyH)
      ctx.strokeRect(a + 0.5, 0.5, b - a - 1, bodyH - 1)
    }

    if (drawRange) {
      // Pinned to the bottom of the widget, not to where the rows happen to
      // end: a short record would otherwise leave it floating mid-card.
      rangeRef.current = drawRangeSelector(
        ctx, h - RANGE_H, plotL, plotW, bounds, view, death, showDeath, overview,
      )
    } else {
      rangeRef.current = null
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

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const l = layoutRef.current
      if (!l.length || !view) return

      // Over the labels: scroll THAT group's concept window.
      if (px < l[0].plotL) {
        const hit = l.find((row) => py >= row.y && py < row.y + row.rowH)
        if (!hit) return
        const win = layout.windows.get(hit.row.key)
        if (!win || win.total <= win.shown) return
        e.preventDefault()
        const cur = offsetsRef.current.get(hit.row.key) ?? 0
        offsetsRef.current.set(
          hit.row.key,
          clamp(cur + (e.deltaY > 0 ? 1 : -1), 0, win.total - win.shown),
        )
        rebuild()
        return
      }

      e.preventDefault()
      if (hitRange(px, py)) {
        panBy(e.deltaY > 0 ? 0.15 : -0.15)
        return
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        panBy((e.shiftKey ? e.deltaY : e.deltaX) > 0 ? 0.15 : -0.15)
        return
      }
      const centre = msAt(px)
      if (centre != null) zoomBy(e.deltaY > 0 ? 1.25 : 0.8, centre)
    },
    [view, layout, msAt, zoomBy, panBy, hitRange, rebuild],
  )

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
          onWheel={onWheel}
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

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** A drawn event's hit box, plus the unit lane's own — which only this widget has. */
type Mark = EventMark & { unit?: UnitStay }

interface LayoutRow {
  y: number
  rowH: number
  row: OverviewRow
  marks: Mark[] | null
  counts: Float64Array | null
  level: 'density' | 'events'
  nb: number
  bw: number
  plotL: number
  clipped: boolean
}

interface BarHit {
  key: string
  trackY: number
  trackH: number
  thumbY: number
  thumbH: number
  x0: number
  x1: number
  max: number
}

interface RangeGeom {
  x0: number
  x1: number
  y0: number
  y1: number
  win: { x0: number; x1: number }
}

type DragState =
  | { kind: 'zoom'; x0: number; x1: number; moved: boolean }
  | { kind: 'bar'; bar: BarHit; grab: number }
  | { kind: 'range'; mode: 'lo' | 'hi' | 'move'; grab: number }

/** Would these events be legible drawn individually, or do the marks collide? */
function fitsIndividually(events: OverviewEvent[], plotW: number, span: number): boolean {
  if (events.length === 0) return true
  if (events.length <= FEW_EVENTS) return true
  return medianGapPx(events.map((e) => e.start), plotW, span) >= MIN_GAP_PX
}

function drawDensity(
  ctx: CanvasRenderingContext2D,
  events: OverviewEvent[] | undefined,
  y: number,
  rowH: number,
  plotL: number,
  nb: number,
  bw: number,
  lo: number,
  span: number,
  colour: string,
): Float64Array {
  const counts = new Float64Array(nb)
  let maxC = 0
  for (const e of events ?? []) {
    const a = e.start
    const b = e.end ?? e.start
    const b0 = clamp(Math.floor(((a - lo) / span) * nb), 0, nb - 1)
    const b1 = clamp(Math.floor(((b - lo) / span) * nb), 0, nb - 1)
    for (let k = b0; k <= b1; k++) {
      counts[k]++
      if (counts[k] > maxC) maxC = counts[k]
    }
  }
  const barH = Math.max(3, Math.min(rowH - 8, 10))
  const barY = y + (rowH - barH) / 2
  if (maxC === 0) {
    // No fetched events: show the row exists but carries no drawn data yet.
    ctx.fillStyle = shade(colour, 0.18)
    ctx.fillRect(plotL, barY + barH / 2 - 0.5, 0, 1)
    return counts
  }
  for (let b = 0; b < nb; b++) {
    if (!counts[b]) continue
    ctx.fillStyle = shade(colour, 0.2 + 0.8 * Math.sqrt(counts[b] / maxC))
    ctx.fillRect(plotL + b * bw, barY, Math.max(1.2, bw), barH)
  }
  return counts
}

function drawUnits(
  ctx: CanvasRenderingContext2D,
  units: UnitStay[],
  y: number,
  rowH: number,
  plotL: number,
  plotW: number,
  x: (ms: number) => number,
  muted: boolean,
): Mark[] {
  const marks: Mark[] = []
  if (muted) return marks
  const barH = Math.max(6, Math.min(rowH - 6, 16))
  const barY = y + (rowH - barH) / 2
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `${Math.min(10, barH - 4)}px Inter, system-ui`

  for (const u of units) {
    const a = x(u.start)
    const b = x(u.end ?? u.start)
    const w = Math.max(2, b - a)
    if (b < plotL || a > plotL + plotW) continue
    // Colour by the standard category, label by the ward: two ICU wards read as
    // the same kind of place while keeping their own names.
    ctx.fillStyle = stableColour(u.category || u.name, UNIT_PALETTE)
    ctx.fillRect(a, barY, w, barH)
    const room = w - 6
    if (room > 24) {
      let s = u.name
      if (ctx.measureText(s).width > room) {
        while (s.length > 1 && ctx.measureText(`${s}…`).width > room) s = s.slice(0, -1)
        s += '…'
      }
      ctx.fillStyle = '#fff'
      ctx.fillText(s, a + 3, barY + barH / 2)
    }
    marks.push({
      x0: Math.max(plotL, a),
      x1: Math.min(plotL + plotW, a + w),
      y0: barY,
      y1: barY + barH,
      unit: u,
    })
  }
  return marks
}

function drawRangeSelector(
  ctx: CanvasRenderingContext2D,
  top: number,
  plotL: number,
  plotW: number,
  bounds: { lo: number; hi: number },
  view: { lo: number; hi: number },
  death: number | null,
  showDeath: boolean,
  overview: OverviewDensity | null,
): RangeGeom {
  const full = bounds.hi - bounds.lo || 1
  const y = top + 6
  const h = RANGE_H - 14

  ctx.fillStyle = 'rgba(148,163,184,0.10)'
  ctx.fillRect(plotL, y, plotW, h)
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.strokeRect(plotL + 0.5, y + 0.5, plotW - 1, h - 1)

  // The whole record's density, so the strip shows WHERE the data is: the
  // admissions stand out as blocks, which is what you aim the window at. An
  // empty frame gives nothing to navigate by.
  if (overview && overview.max > 0) {
    const bw = plotW / overview.counts.length
    ctx.fillStyle = '#cbd5e1'
    for (let b = 0; b < overview.counts.length; b++) {
      const n = overview.counts[b]
      if (!n) continue
      const bh = Math.max(1, (h - 4) * Math.sqrt(n / overview.max))
      ctx.fillRect(plotL + b * bw, y + h - 2 - bh, Math.max(1, bw), bh)
    }
  }

  if (showDeath && death != null) {
    const dx = plotL + ((death - bounds.lo) / full) * plotW
    ctx.strokeStyle = '#dc2626'
    ctx.beginPath()
    ctx.moveTo(dx, y)
    ctx.lineTo(dx, y + h)
    ctx.stroke()
  }

  const wx0 = plotL + ((view.lo - bounds.lo) / full) * plotW
  const wx1 = plotL + ((view.hi - bounds.lo) / full) * plotW
  ctx.fillStyle = 'rgba(15,23,42,.10)'
  ctx.fillRect(plotL, y, Math.max(0, wx0 - plotL), h)
  ctx.fillRect(Math.min(wx1, plotL + plotW), y, Math.max(0, plotL + plotW - wx1), h)

  ctx.fillStyle = 'rgba(37,99,235,.08)'
  ctx.fillRect(wx0, y, Math.max(1, wx1 - wx0), h)
  ctx.strokeStyle = '#2563eb'
  ctx.strokeRect(wx0 + 0.5, y + 0.5, Math.max(1, wx1 - wx0) - 1, h - 1)
  ctx.fillStyle = '#2563eb'
  for (const hx of [wx0, wx1]) ctx.fillRect(hx - 1.5, y + h / 2 - 7, 3, 14)

  return { x0: plotL, x1: plotL + plotW, y0: y, y1: y + h, win: { x0: wx0, x1: wx1 } }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The concept's identifiers on one muted line: the id, then the vocabulary code.
 * Either may be missing — MIMIC's d_items has no code column — so the separator
 * only appears between two present values.
 */
function conceptRef(id?: string | null, code?: string | null): string | null {
  return [id, code].filter(Boolean).join(' · ') || null
}

/** Cache key: a row's events depend on the row and the window they were fetched for. */
function eventKey(row: OverviewRow, view: { lo: number; hi: number }): string {
  return `${row.key}|${row.kind}|${row.conceptIds.join(',')}|${Math.round(view.lo)}|${Math.round(view.hi)}`
}

function setOffsetFromBar(bar: BarHit, thumbTop: number, offsets: Map<string, number>): void {
  const travel = bar.trackH - bar.thumbH
  const frac = travel > 0 ? clamp((thumbTop - bar.trackY) / travel, 0, 1) : 0
  offsets.set(bar.key, Math.round(frac * bar.max))
}

function unitCount(units: UnitStay[]): number {
  return new Set(units.map((u) => u.name)).size
}

/** A tooltip's content plus where the pointer was, in viewport coordinates. */
interface TipContent {
  title: string
  /** Vocabulary code, shown small and muted directly under the name. */
  code?: string | null
  /** The headline figure, shown large: a value with its unit, or a unit name. */
  value?: string
  lines: string[]
  x: number
  y: number
}

/**
 * Tooltip content for whatever is under the cursor.
 *
 * In the gutter it answers "what is this row, and what did the label say before
 * it was cut". Over the plot it names the exact event, with its value and unit —
 * or, on a density band, the bucket's count and whether zooming would reveal
 * the values.
 */
function describeHit(
  hit: LayoutRow,
  px: number,
  py: number,
  inGutter: boolean,
  view: { lo: number; hi: number },
  t: (k: string, o?: Record<string, unknown>) => string,
  conceptsById: Map<string, OverviewConceptRow>,
): Omit<TipContent, 'x' | 'y'> | null {
  const label = rowLabel(hit.row, t)

  if (inGutter) {
    // The full name matters most when the gutter had to truncate it.
    const nEvents = Number(hit.row.eventCount)
    const events = `${fmtN(hit.row.eventCount)} ${
      nEvents === 1 ? t('patient_data.overview_events_one') : t('patient_data.overview_events')
    }`
    const nConcepts = hit.row.kind === 'concept' ? 0 : Number(hit.row.conceptCount)
    const counts =
      hit.row.kind === 'concept'
        ? events
        : `${fmtN(hit.row.conceptCount)} ${
            nConcepts === 1
              ? t('patient_data.overview_concepts_one')
              : t('patient_data.overview_concepts')
          } · ${events}`
    const lines = [counts]
    if (hit.row.kind === 'concept' && hit.row.unit) lines.push(hit.row.unit)
    // Show the original name only when shortening actually dropped something.
    // Comparing the raw strings would show it for every drug, since reordering
    // "Oral Tablet" into ", oral tablet" changes the text without hiding a word.
    const full = hit.row.kind === 'concept' ? hit.row.label : label
    if (!sameWords(full, label)) lines.unshift(full)
    return { title: label, code: conceptRef(hit.row.conceptId, hit.row.conceptCode), lines }
  }

  // Individual marks: name the event under the cursor.
  if (hit.marks) {
    let best: Mark | null = null
    let bestD = Infinity
    for (const m of hit.marks) {
      if (px >= m.x0 && px <= m.x1 && py >= m.y0 && py <= m.y1) {
        best = m
        bestD = 0
        break
      }
      // Distance to the mark's EDGE, not its centre: a stay bar can be hundreds
      // of pixels wide, and measuring from its centre puts the cursor "far" from
      // a bar it is sitting right next to.
      const d = px < m.x0 ? m.x0 - px : px > m.x1 ? px - m.x1 : 0
      if (d < bestD) {
        bestD = d
        best = m
      }
    }
    if (best && bestD <= 6) {
      if (best.unit) {
        const u = best.unit
        const when =
          u.end != null
            ? `${fmtStamp(u.start)} → ${fmtStamp(u.end)} · ${fmtDur(u.end - u.start)}`
            : fmtStamp(u.start)
        // The ward's name is the headline — it is what the row exists to answer.
        const lines = [when]
        if (u.category && u.category !== u.name) lines.push(u.category)
        return { title: label, value: u.name, lines }
      }
      if (best.event) {
        const e = best.event
        // A number is only meaningful next to the concept it measures. On an
        // aggregate row ("Other", a concept class) the dot stands for many
        // concepts with different units, so `hit.row.unit` is not this event's
        // unit and the bare figure — 12.5 of what? — says nothing.
        const unit = hit.row.unit ?? ''
        const rate = hourlyRate(e.value, e.start, e.end)
        const total = e.value != null ? `${fmtValue(e.value)}${unit ? ` ${unit}` : ''}` : null
        // Dose and rate read as one fact — "500 mg · 55.56 mg/h" — because for an
        // infusion neither answers the question alone. The rate stays an average
        // over the recorded window, which is why the route sits below it.
        // A value already expressed per hour must not be divided by the duration
        // a second time — that prints a confidently wrong "mL/h".
        const dose =
          total && rate != null && !unitIsRate(unit)
            ? `${total} · ${fmtValue(rate)} ${unit}/h`
            : total
        const value = hit.row.mixed ? undefined : (dose ?? e.text ?? undefined)
        const when =
          e.end != null
            ? `${fmtStamp(e.start)} → ${fmtStamp(e.end)} · ${fmtDur(e.end - e.start)}`
            : fmtStamp(e.start)
        const lines = [when]
        // The route is what tells a drip from a single shot: the standard
        // vocabulary calls both "Intravenous", so the reader judges, not the code.
        if (e.route) lines.push(e.route)
        // On a class/domain row the table name only repeats the header. What is
        // actually unknown is how much this single dot stands for.
        const merged = best.merged
        let title = label
        let code = conceptRef(hit.row.conceptId, hit.row.conceptCode)
        if (hit.row.mixed && (!merged || merged.length === 1) && e.conceptId) {
          // One event on an aggregate row: with the figure suppressed, name the
          // concept it belongs to — that is what the row itself cannot show.
          const c = conceptsById.get(String(e.conceptId))
          if (c) {
            title = c.conceptName
            code = conceptRef(c.conceptId, c.conceptCode)
          }
        }
        if (merged && merged.length > 1) {
          const concepts = new Set(merged.map((m) => m.conceptId).filter(Boolean)).size
          const events = `${fmtN(merged.length)} ${
            merged.length === 1
              ? t('patient_data.overview_events_one')
              : t('patient_data.overview_events')
          }`
          lines.push(
            concepts > 1
              ? `${events} · ${fmtN(concepts)} ${t('patient_data.overview_concepts')}`
              : events,
          )
        }
        return { title, code, value, lines }
      }
    }
    return null
  }

  // Density band: the bucket count, and whether zooming would help.
  if (hit.counts) {
    const b = Math.floor((px - hit.plotL) / hit.bw)
    const n = b >= 0 && b < hit.nb ? hit.counts[b] : 0
    if (!n) return null
    const span = view.hi - view.lo
    const t0 = view.lo + (b * span) / hit.nb
    const t1 = view.lo + ((b + 1) * span) / hit.nb
    const unit = n > 1 ? t('patient_data.overview_events') : t('patient_data.overview_events_one')
    // A category row aggregates concepts, so it stays a band at every zoom —
    // promising that zooming reveals values would be a lie.
    const hint = hit.row.mixed
      ? t('patient_data.overview_open_category')
      : t('patient_data.overview_zoom_hint')
    return {
      title: label,
      value: `${fmtN(n)} ${unit}`,
      lines: [`${fmtStamp(t0)} → ${fmtStamp(t1)}`, hint],
    }
  }
  return null
}


/** ISO string for a timestamp, or null when it isn't a usable date. */
function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** DuckDB counts arrive as BigInt in WASM and as strings from the server. */
const fmtN = (n: unknown) => {
  const v = typeof n === 'bigint' ? Number(n) : Number(n)
  return Number.isFinite(v) ? v.toLocaleString() : '0'
}

function fmtAxis(ms: number, withClock: boolean, locale: string): string {
  const d = new Date(ms)
  return withClock
    ? d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Generic row labels go through i18n; concept and table names come from the data. */
function rowLabel(row: OverviewRow, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (row.kind === 'other') {
    if (row.scrolledAbove || row.scrolledBelow) {
      return t('patient_data.overview_other_scrolled', {
        above: row.scrolledAbove ?? 0,
        below: row.scrolledBelow ?? 0,
      })
    }
    return t('patient_data.overview_other')
  }
  if (row.kind === 'class') {
    if (row.label === '__otherClasses') return t('patient_data.overview_other_classes')
    if (row.label === '__unmapped') return t('patient_data.overview_other')
    return row.label
  }
  if (row.kind === 'concept' && looksLikeDrugName(row.label)) return shortenDrugName(row.label)
  return row.label.replace(/_/g, ' ')
}

/**
 * Hover tooltip, in the prototype's layout: the name on top, the value large
 * beneath it, then the timing in muted text.
 *
 * Rendered through a portal to document.body. Each react-grid item is a
 * transformed stacking context, and a `fixed` element inside a CSS transform is
 * positioned relative to THAT ancestor rather than the viewport — so a tooltip
 * left in place drifts by the widget's own screen offset, which is why it moved
 * when the sidebar was collapsed.
 */
function HoverTip({ tip }: { tip: TipContent }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: tip.x + 14, top: tip.y + 16 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Measured after paint, because flipping near an edge needs the real size.
    const r = el.getBoundingClientRect()
    const left = Math.max(
      6,
      tip.x + 14 + r.width > window.innerWidth - 8 ? tip.x - r.width - 14 : tip.x + 14,
    )
    const top = Math.max(
      6,
      tip.y + 16 + r.height > window.innerHeight - 8 ? tip.y - r.height - 10 : tip.y + 16,
    )
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [tip])

  return createPortal(
    <div
      ref={ref}
      className="pointer-events-none fixed z-[9999] max-w-[340px] space-y-1 rounded-md bg-slate-900 px-3 py-2 text-white shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="text-xs font-semibold leading-normal">{tip.title}</div>
      {tip.code && <div className="text-[10px] leading-normal text-slate-400">{tip.code}</div>}
      {tip.value && <div className="text-xs leading-normal text-slate-100">{tip.value}</div>}
      {tip.lines.map((line, i) => (
        <div key={i} className="text-[10px] leading-normal text-slate-400">
          {line}
        </div>
      ))}
    </div>,
    document.body,
  )
}

/** Right-click actions on a category: fold it, or mute it. */
function CategoryMenu({
  row,
  x,
  y,
  rows,
  collapsed,
  hidden,
  onClose,
  onChanged,
  t,
}: {
  row: OverviewRow
  x: number
  y: number
  rows: OverviewRow[]
  collapsed: Set<string>
  hidden: Set<string>
  onClose: () => void
  onChanged: () => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, innerWidth - r.width - 6),
      top: Math.min(y, innerHeight - r.height - 6),
    })
  }, [x, y])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const name = rowLabel(row, t)
  const isClass = row.kind === 'class'
  // A class row folds only its class; a table row folds the whole table.
  const key = isClass ? row.key : row.table
  const tables = [...new Set(rows.filter((r) => r.kind === 'table').map((r) => r.table))]
  const classesHere = rows.filter((r) => r.kind === 'class' && r.table === row.table)

  const act = (fn: () => void) => () => {
    fn()
    onClose()
    onChanged()
  }
  const toggle = (set: Set<string>, k: string) => (set.has(k) ? set.delete(k) : set.add(k))

  const items: ({ sep: true } | { label: string; icon: string; run: () => void })[] = [
    collapsed.has(key)
      ? { label: t('patient_data.overview_expand', { name }), icon: 'expand', run: () => collapsed.delete(key) }
      : { label: t('patient_data.overview_collapse', { name }), icon: 'collapse', run: () => collapsed.add(key) },
    ...(isClass
      ? [
          {
            label: t('patient_data.overview_collapse_other_classes'),
            icon: 'others',
            run: () => {
              for (const c of classesHere) {
                if (c.key === key) collapsed.delete(c.key)
                else collapsed.add(c.key)
              }
            },
          },
        ]
      : [
          {
            label: t('patient_data.overview_collapse_others'),
            icon: 'others',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) collapsed.delete(tb)
                else collapsed.add(tb)
              }
            },
          },
          {
            label: t('patient_data.overview_expand_others'),
            icon: 'others',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) collapsed.add(tb)
                else collapsed.delete(tb)
              }
            },
          },
        ]),
    { label: t('patient_data.overview_collapse_all'), icon: 'collapseAll', run: () => tables.forEach((tb) => collapsed.add(tb)) },
    { label: t('patient_data.overview_expand_all'), icon: 'expandAll', run: () => collapsed.clear() },
    { sep: true },
    hidden.has(key)
      ? { label: t('patient_data.overview_show', { name }), icon: 'show', run: () => hidden.delete(key) }
      : { label: t('patient_data.overview_hide', { name }), icon: 'hide', run: () => toggle(hidden, key) },
    ...(isClass
      ? [
          {
            label: t('patient_data.overview_hide_other_classes'),
            icon: 'hide',
            run: () => {
              for (const c of classesHere) {
                if (c.key === key) hidden.delete(c.key)
                else hidden.add(c.key)
              }
            },
          },
        ]
      : [
          {
            label: t('patient_data.overview_hide_others'),
            icon: 'hide',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) hidden.delete(tb)
                else hidden.add(tb)
              }
            },
          },
          {
            label: t('patient_data.overview_show_others'),
            icon: 'show',
            run: () => {
              for (const tb of tables) {
                if (tb === row.table) hidden.add(tb)
                else hidden.delete(tb)
              }
            },
          },
        ]),
    { label: t('patient_data.overview_show_all'), icon: 'show', run: () => hidden.clear() },
  ]

  // Portalled for the same reason as the tooltip: `fixed` inside a react-grid
  // item is positioned against that transformed ancestor, not the viewport.
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[200px] rounded-md border bg-popover p-1 shadow-md"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            type="button"
            onClick={act(it.run)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
          >
            <MenuIcon name={it.icon} />
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

/**
 * Menu icons. The pairs are deliberately mirror images — chevron down/right for
 * expand and collapse, open/struck eye for show and hide — so the two axes
 * (fold vs mute) stay distinguishable at a glance.
 */
function MenuIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    expand: 'M3 5.5 L7 9.5 L11 5.5',
    collapse: 'M5.5 3 L9.5 7 L5.5 11',
    expandAll: 'M3 4 L7 8 L11 4 M3 8.5 L7 12.5 L11 8.5',
    collapseAll: 'M3 7 L7 3 L11 7 M3 11.5 L7 7.5 L11 11.5',
    show: 'M1 7 C3 3.5 11 3.5 13 7 C11 10.5 3 10.5 1 7 Z M5.2 7 A1.8 1.8 0 1 0 8.8 7 A1.8 1.8 0 1 0 5.2 7',
    hide: 'M1 7 C3 3.5 11 3.5 13 7 C11 10.5 3 10.5 1 7 Z M2 12 L12 2',
    others: 'M2 3.5 L12 3.5 M2 7 L12 7 M2 10.5 L12 10.5',
    copy: 'M5 5 L5 2.5 L12 2.5 L12 9.5 L9.5 9.5 M2 5 L9 5 L9 12 L2 12 Z',
    check: 'M2.5 7.5 L5.5 10.5 L11.5 3.5',
  }
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name] ?? ''} />
    </svg>
  )
}

function Message({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div
      className={`flex h-full items-center justify-center p-4 text-center text-xs ${
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      {text}
    </div>
  )
}

/**
 * Right-click actions on a data point: carry the concept's identifiers out.
 *
 * The name is what you read, but the id and the code are what you paste into a
 * query or a vocabulary browser — and neither is selectable on a canvas.
 */
function ConceptCopyMenu({
  concept,
  x,
  y,
  onClose,
  t,
}: {
  concept: OverviewConceptRow
  x: number
  y: number
  onClose: () => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, innerWidth - r.width - 6),
      top: Math.min(y, innerHeight - r.height - 6),
    })
  }, [x, y])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  // The menu stays open briefly after a copy so the tick is actually seen.
  const copy = (value: string, key: string) => () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(key)
      setTimeout(onClose, 600)
    })
  }

  const items = [
    { key: 'name', label: t('patient_data.overview_copy_name'), value: concept.conceptName },
    { key: 'id', label: t('patient_data.overview_copy_id'), value: concept.conceptId },
    ...(concept.conceptCode
      ? [{ key: 'code', label: t('patient_data.overview_copy_code'), value: concept.conceptCode }]
      : []),
  ]

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[220px] rounded-md border bg-popover p-1 shadow-md"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-2 py-1 text-[10px] text-muted-foreground">
        {concept.conceptName}
      </div>
      <div className="my-1 h-px bg-border" />
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={copy(it.value, it.key)}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
        >
          <MenuIcon name={copied === it.key ? 'check' : 'copy'} />
          <span className="flex-1 truncate">{it.label}</span>
          <span className="max-w-[90px] truncate font-mono text-[10px] text-muted-foreground">
            {it.value}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
