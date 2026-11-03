import { useEffect } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { PatientScope } from '@/lib/duckdb/patient-scope'
import { patientQuery } from '../patient-prefetch'
import { buildOverviewDensityQuery, buildOverviewEventsQuery, buildOverviewTileDensityQuery, TOTAL_ROW_KEY } from '@/lib/duckdb/patient-overview-queries'
import { RANGE_BUCKETS, type OverviewDensity } from './overview-helpers'
import { deviceOverviewBudget } from './overview-budget'
import { toMs } from '@/lib/duckdb/value-coercion'
import {
  bucketMsFor,
  eventWindowFor,
  type OverviewDataCache,
  runLimited,
  tileBounds,
  tilesCovering,
  TILE_BUCKETS,
} from './overview-tiles'
import type { OverviewRow } from './overview-layout'
import type { OverviewEvent } from './event-marks'

/** What this machine reads per row and at once (overview-budget.ts). */
const BUDGET = deviceOverviewBudget()

type Span = { lo: number; hi: number }

/** The range selector's strip still to read: every event of `tables` over the
 *  record's span, in RANGE_BUCKETS slices. */
export interface StripRequest extends Span {
  tables: string[]
}

interface OverviewDataInput {
  visible: boolean
  view: Span | null
  bounds: Span | null
  rows: OverviewRow[]
  hiddenRef: { readonly current: Set<string> }
  dataRef: { readonly current: OverviewDataCache }
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
  selectedPatientId: string | null
  scope: PatientScope
  /** The plot width the last paint used: the bucket width the painter looks up. */
  paintedPlotW: number
  repaint: () => void
  strip: StripRequest | null
  onStrip: (density: OverviewDensity | null) => void
}

/**
 * Fetch what the view needs.
 *
 * Rows sparse enough to draw one by one get their events, over a window wider
 * than the view; the others get density tiles at about a pixel per bucket
 * (overview-tiles.ts). Both are cached, so a pan or a zoom only reads what came
 * into view. Debounced, so a drag or a wheel spin reads once it settles, and
 * aborted when the view moves on — the server stops the query in flight.
 */
export function useOverviewData({
  visible, view, bounds, rows, hiddenRef, dataRef,
  dataSourceId, schemaMapping, selectedPatientId, scope, paintedPlotW, repaint, strip, onStrip,
}: OverviewDataInput): void {
  useEffect(() => {
    if (!visible || !view || !bounds || !dataSourceId || !schemaMapping || !selectedPatientId) return
    if (!paintedPlotW) return
    const plotW = paintedPlotW
    const cache = dataRef.current
    const span = Math.max(1, view.hi - view.lo)
    const bucketMs = bucketMsFor(span, plotW)

    const shown = rows.filter((row) =>
      row.kind !== 'units' && !hiddenRef.current.has(row.table) && !hiddenRef.current.has(row.key))

    const tasks: (() => Promise<void>)[] = []
    const dense: OverviewRow[] = []
    const eventRows: OverviewRow[] = []
    for (const row of shown) {
      const key = rowCacheKey(row)
      if (row.conceptIds.length > 0 && wantsEvents(row, view, bounds, plotW)) {
        if (cache.needsEvents(key, view.lo, view.hi)) {
          eventRows.push(row)
          tasks.push(() => fetchEvents(row, key))
        }
        const w = cache.eventsFor(key, view.lo, view.hi)
        if (!w?.truncated) continue
      }
      dense.push(row)
    }
    // Every missing tile of every dense row in ONE query: on files not sorted by
    // patient each read is a full scan, so one per tile cost as many scans.
    const tiles = tilesCovering(view.lo, view.hi, bucketMs)
    const missing = dense.filter((row) => tiles.some((t) => !cache.hasTile(rowCacheKey(row), bucketMs, t)))
    // The range selector's strip, while the view holds the whole record (as a
    // record first loads): counted in the same read as the tiles, rather than
    // reading every event of the patient once more.
    const stripWithTiles = !!strip && view.lo <= strip.lo && view.hi >= strip.hi
    if (missing.length || stripWithTiles) {
      const needed = tiles.filter((t) => stripWithTiles || missing.some((row) => !cache.hasTile(rowCacheKey(row), bucketMs, t)))
      tasks.push(() => fetchTiles(missing, needed[0], needed[needed.length - 1], stripWithTiles ? strip : null))
    } else if (strip) {
      tasks.push(() => fetchStrip(strip))
    }
    if (tasks.length === 0) return

    const controller = new AbortController()
    const signal = controller.signal

    // Marked as soon as they are due, debounce included, and unmarked as each
    // read ends or the view moves on.
    const due = new Set<string>()
    const mark = (keys: string[]) => {
      for (const k of keys) { due.add(k); cache.pending.add(k) }
    }
    const unmark = (keys: string[]) => {
      for (const k of keys) { due.delete(k); cache.pending.delete(k) }
      repaint()
    }

    async function fetchEvents(row: OverviewRow, key: string) {
      const win = eventWindowFor(view!.lo, view!.hi)
      const from = isoOrNull(win.lo)
      const to = isoOrNull(win.hi)
      const sql = from && to
        ? buildOverviewEventsQuery(schemaMapping!, selectedPatientId!, scope, row.table, row.conceptIds, from, to, BUDGET.eventLimit)
        : null
      if (!sql) return unmark([key])
      try {
        const raw = await patientQuery(dataSourceId!, sql, { signal, origin: `Data overview · events of “${row.label}” in view` })
        cache.putEvents(key, { ...win, events: raw.map(toOverviewEvent), truncated: raw.length >= BUDGET.eventLimit })
        repaint()
      } catch (err) {
        if (signal.aborted) return
        // A row that fails to load falls back to a density band — which looks
        // exactly like a row aggregated on purpose. Staying silent here hid a
        // broken column behind a plausible figure, so the failure is reported.
        console.warn('[patient-overview] events query failed for', row.label, err)
        cache.putEvents(key, { ...win, events: [], truncated: false })
      } finally {
        if (!signal.aborted) unmark([key])
      }
    }

    async function fetchStrip(wanted: StripRequest) {
      const from = isoOrNull(wanted.lo)
      const to = isoOrNull(wanted.hi)
      const bands = wanted.tables.map((table) => ({ key: table, table, conceptIds: [] }))
      const sql = from && to && bands.length
        ? buildOverviewDensityQuery(schemaMapping!, selectedPatientId!, scope, from, to, RANGE_BUCKETS, bands)
        : null
      if (!sql) return onStrip(null)
      try {
        const raw = await patientQuery(dataSourceId!, sql, { signal, origin: 'Data overview · density strip of the record' })
        onStrip(stripOf(raw.map((r) => [Number(r.bucket), Number(r.n ?? 0)])))
      } catch {
        // The strip simply stays empty; it is navigation aid, not data.
        if (!signal.aborted) onStrip(null)
      }
    }

    async function fetchTiles(missing: OverviewRow[], firstTile: number, lastTile: number, withStrip: StripRequest | null) {
      const from = isoOrNull(tileBounds(firstTile, bucketMs)[0])
      const to = isoOrNull(tileBounds(lastTile, bucketMs)[1])
      const sql = from && to
        ? buildOverviewTileDensityQuery(schemaMapping!, selectedPatientId!, scope,
          missing.map((row) => ({ key: rowCacheKey(row), table: row.table, conceptIds: row.conceptIds })), bucketMs, from, to,
          withStrip?.tables ?? [])
        : null
      const keys = missing.map(rowCacheKey)
      if (!sql) return unmark(keys)
      try {
        const raw = await patientQuery(dataSourceId!, sql, { signal, origin: `Data overview · density tiles of ${missing.length} rows${withStrip ? ', with the strip' : ''}` })
        if (withStrip) {
          // Each bucket in the slice its start falls in.
          const span = Math.max(1, withStrip.hi - withStrip.lo)
          onStrip(stripOf(raw.filter((r) => r.row_key === TOTAL_ROW_KEY).map((r) => [
            Math.floor(((Number(r.bucket) * bucketMs) - withStrip.lo) / span * RANGE_BUCKETS), Number(r.n ?? 0),
          ])))
        }
        const counts = new Map(missing.map((row) => [rowCacheKey(row), new Float64Array((lastTile - firstTile + 1) * TILE_BUCKETS)]))
        const first = firstTile * TILE_BUCKETS
        for (const r of raw) {
          const i = Number(r.bucket) - first
          const arr = counts.get(String(r.row_key))
          if (arr && i >= 0 && i < arr.length) arr[i] += Number(r.n ?? 0)
        }
        for (const [key, arr] of counts) {
          for (let t = firstTile; t <= lastTile; t++) {
            const at = (t - firstTile) * TILE_BUCKETS
            cache.putTile(key, bucketMs, t, arr.slice(at, at + TILE_BUCKETS))
          }
        }
        repaint()
      } catch (err) {
        if (!signal.aborted) console.warn('[patient-overview] density query failed', err)
      } finally {
        if (!signal.aborted) unmark(keys)
      }
    }

    mark([...eventRows.map(rowCacheKey), ...missing.map(rowCacheKey)])
    repaint()
    const timer = setTimeout(() => void runLimited(tasks, BUDGET.concurrency, signal), 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
      for (const k of due) cache.pending.delete(k)
    }
  }, [visible, view, bounds, rows, hiddenRef, dataRef, dataSourceId, schemaMapping, selectedPatientId, scope, paintedPlotW, repaint, strip, onStrip])
}

/** The strip's counts from (slice, count) pairs; slices outside it are dropped. */
function stripOf(pairs: [number, number][]): OverviewDensity {
  const counts = new Float64Array(RANGE_BUCKETS)
  let max = 0
  for (const [i, n] of pairs) {
    if (!Number.isFinite(i) || i < 0 || i >= RANGE_BUCKETS) continue
    counts[i] += n
    if (counts[i] > max) max = counts[i]
  }
  return { counts, max }
}

/** A row's cache key: what it shows depends on its concepts, not its position. */
export function rowCacheKey(row: OverviewRow): string {
  return `${row.kind}|${row.key}|${row.conceptIds.join(',')}`
}

/**
 * Whether a row is worth reading event by event at this zoom: its whole-record
 * count scaled to the visible slice stays under ~1.5 events a pixel. Testing the
 * whole-record count directly would lock every busy row into density at every
 * zoom level; the row limit caps the cost of guessing wrong.
 */
export function wantsEvents(row: OverviewRow, view: { lo: number; hi: number }, bounds: { lo: number; hi: number }, plotW: number): boolean {
  const recordSpan = Math.max(1, bounds.hi - bounds.lo)
  const inView = row.eventCount * ((view.hi - view.lo) / recordSpan)
  return inView / Math.max(1, plotW) < 1.5
}

function toOverviewEvent(r: Record<string, unknown>): OverviewEvent {
  return {
    start: toMs(r.event_start) ?? 0,
    end: toMs(r.event_end),
    value: r.value_number == null ? null : Number(r.value_number),
    text: r.value_string == null ? null : String(r.value_string),
    conceptId: r.concept_id == null ? null : String(r.concept_id),
    route: r.route == null ? null : String(r.route),
    rate: r.rate_value == null ? null : Number(r.rate_value),
    rateUnit: r.rate_unit == null ? null : String(r.rate_unit),
  }
}

/** ISO string for a timestamp, or null when it isn't a usable date. */
export function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
