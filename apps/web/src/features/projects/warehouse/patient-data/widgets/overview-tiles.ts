/**
 * What the Data overview loads at each zoom level, and what it keeps.
 *
 * A record of tens of millions of events cannot be fetched whole, nor re-fetched
 * on every pan. Two kinds of data, each cached so that panning and zooming reuse
 * what was read:
 *
 * - **Density** for rows too dense to draw event by event: counts per time
 *   bucket, aggregated in SQL. Buckets have an ABSOLUTE width — a power of two
 *   milliseconds, about one pixel — and are fetched in tiles of `TILE_BUCKETS`,
 *   like map tiles: a pan fetches only the tiles that came into view, and the
 *   counts stay exact whatever the row holds.
 * - **Events** for rows sparse enough to draw one by one, read over a window
 *   wider than the view, so a pan within it and any zoom into it cost nothing.
 *   A window that hit the row limit is not trusted for drawing: the row is drawn
 *   as density until a narrower window fits.
 */

import type { OverviewEvent } from './event-marks'

/** Buckets per density tile. */
export const TILE_BUCKETS = 256

/** Smallest bucket, in ms: below a second, finer buckets show nothing more. */
const MIN_BUCKET_MS = 1024

/** Tiles kept, across rows and zoom levels, before the oldest are dropped. */
const MAX_TILES = 4000
/** Event windows kept per row. */
const MAX_WINDOWS = 6

/** The bucket width for a view: the power of two at or above one pixel's span. */
export function bucketMsFor(span: number, plotW: number): number {
  const perPixel = Math.max(1, span) / Math.max(1, plotW)
  return Math.max(MIN_BUCKET_MS, 2 ** Math.ceil(Math.log2(perPixel)))
}

/** Indices of the tiles covering [lo, hi) at this bucket width. */
export function tilesCovering(lo: number, hi: number, bucketMs: number): number[] {
  const t = bucketMs * TILE_BUCKETS
  const first = Math.floor(lo / t)
  const last = Math.max(first, Math.ceil(hi / t) - 1)
  const out: number[] = []
  for (let i = first; i <= last; i++) out.push(i)
  return out
}

/** [start, end) of a tile, in ms. */
export function tileBounds(tile: number, bucketMs: number): [number, number] {
  const t = bucketMs * TILE_BUCKETS
  return [tile * t, (tile + 1) * t]
}

/**
 * The window to read events over for a view: the view padded by its own span on
 * each side, snapped to a grid of that size so nearby views ask for the same one.
 */
export function eventWindowFor(lo: number, hi: number): { lo: number; hi: number } {
  const span = Math.max(1, hi - lo)
  const q = 2 ** Math.ceil(Math.log2(span))
  return { lo: Math.floor(lo / q) * q - q, hi: Math.ceil(hi / q) * q + q }
}

export interface EventWindow {
  lo: number
  hi: number
  events: OverviewEvent[]
  /** The read hit its row limit: the window holds only its earliest events. */
  truncated: boolean
}

/** Per widget: the density tiles and event windows read so far. */
export class OverviewDataCache {
  private tiles = new Map<string, Float64Array>()
  private windows = new Map<string, EventWindow[]>()

  clear(): void {
    this.tiles.clear()
    this.windows.clear()
  }

  hasTile(rowKey: string, bucketMs: number, tile: number): boolean {
    return this.tiles.has(tileKey(rowKey, bucketMs, tile))
  }

  /** Store a tile's counts; `counts[i]` is bucket `tile * TILE_BUCKETS + i`. */
  putTile(rowKey: string, bucketMs: number, tile: number, counts: Float64Array): void {
    const key = tileKey(rowKey, bucketMs, tile)
    this.tiles.delete(key)
    this.tiles.set(key, counts)
    // Map order is insertion order: the first keys are the least recently stored.
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!)
  }

  /**
   * Counts per pixel over [lo, hi] for a row, from the tiles at `bucketMs` — or
   * from a neighbouring level already read, so a zoom shows the previous figure
   * rather than a blank while its own level loads. Null when nothing covers it.
   */
  pixelCounts(rowKey: string, lo: number, hi: number, nb: number, bucketMs: number): Float64Array | null {
    // The exact level, then a finer one (a narrower plot asked for it), then
    // coarser ones standing in while this level loads.
    const levels = [bucketMs, bucketMs / 2, bucketMs / 4, ...[2, 4, 8, 16, 32].map((k) => bucketMs * k)]
    for (const level of levels) {
      const tiles = tilesCovering(lo, hi, level)
      if (!tiles.every((t) => this.tiles.has(tileKey(rowKey, level, t)))) continue
      const out = new Float64Array(nb)
      const span = Math.max(1, hi - lo)
      for (const t of tiles) {
        const counts = this.tiles.get(tileKey(rowKey, level, t))!
        for (let i = 0; i < TILE_BUCKETS; i++) {
          if (!counts[i]) continue
          const start = (t * TILE_BUCKETS + i) * level
          const end = start + level
          if (end <= lo || start >= hi) continue
          // A bucket wider than a pixel (a coarser level standing in) spreads
          // over the pixels it spans rather than piling onto one.
          const p0 = Math.max(0, Math.floor(((start - lo) / span) * nb))
          const p1 = Math.min(nb - 1, Math.floor(((end - 1 - lo) / span) * nb))
          const share = counts[i] / (p1 - p0 + 1)
          for (let p = p0; p <= p1; p++) out[p] += share
        }
      }
      return out
    }
    return null
  }

  /** The narrowest window read for this row that covers [lo, hi]. */
  eventsFor(rowKey: string, lo: number, hi: number): EventWindow | null {
    let best: EventWindow | null = null
    for (const w of this.windows.get(rowKey) ?? []) {
      if (w.lo > lo || w.hi < hi) continue
      if (!best || w.hi - w.lo < best.hi - best.lo) best = w
    }
    return best
  }

  /**
   * Whether a view needs a new event read: nothing covers it, or what covers it
   * was truncated over a window much wider than this view would ask for.
   */
  needsEvents(rowKey: string, lo: number, hi: number): boolean {
    const w = this.eventsFor(rowKey, lo, hi)
    if (!w) return true
    if (!w.truncated) return false
    const want = eventWindowFor(lo, hi)
    return w.hi - w.lo > 2 * (want.hi - want.lo)
  }

  putEvents(rowKey: string, window: EventWindow): void {
    const list = (this.windows.get(rowKey) ?? []).filter((w) => w.lo !== window.lo || w.hi !== window.hi)
    list.push(window)
    while (list.length > MAX_WINDOWS) list.shift()
    this.windows.set(rowKey, list)
  }
}

function tileKey(rowKey: string, bucketMs: number, tile: number): string {
  return `${rowKey}\u0001${bucketMs}\u0001${tile}`
}

/**
 * Run `tasks` at most `limit` at a time, stopping early once `signal` aborts.
 * A failing task does not stop the others: each reports its own failure.
 */
export async function runLimited(tasks: (() => Promise<void>)[], limit: number, signal: AbortSignal): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < tasks.length && !signal.aborted) {
      const task = tasks[next++]
      await task()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}
