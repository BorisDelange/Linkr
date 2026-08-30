/**
 * The visible time window of a timeline, and the gestures that move it.
 *
 * Dygraph brings its own zoom and range selector; the mixed-shape renderer has
 * to provide them, so the arithmetic lives here where it can be tested. Nothing
 * in this file touches the DOM.
 */

export interface TimeWindow {
  lo: number
  hi: number
}

/** Smallest window the user can zoom into: one second. Below that the axis
 *  labels all collapse to the same instant and panning feels broken. */
export const MIN_SPAN_MS = 1000

/** Clamp a window inside the record's bounds, keeping its span where possible. */
export function clampWindow(view: TimeWindow, bounds: TimeWindow): TimeWindow {
  const fullSpan = bounds.hi - bounds.lo
  const span = Math.min(Math.max(view.hi - view.lo, MIN_SPAN_MS), fullSpan || MIN_SPAN_MS)
  // Slide rather than squash: a window dragged past an edge keeps its width and
  // stops against the edge, which is what a map pan does.
  let lo = view.lo
  if (lo < bounds.lo) lo = bounds.lo
  if (lo + span > bounds.hi) lo = bounds.hi - span
  return { lo, hi: lo + span }
}

/**
 * Zoom around a focal point — the cursor, so the timestamp under it stays put.
 *
 * `factor` below 1 zooms in. `at` is the focal position as a 0..1 fraction of
 * the plot width.
 */
export function zoomWindow(
  view: TimeWindow,
  bounds: TimeWindow,
  factor: number,
  at: number,
): TimeWindow {
  const span = view.hi - view.lo
  const focus = view.lo + span * Math.min(1, Math.max(0, at))
  const nextSpan = Math.min(Math.max(span * factor, MIN_SPAN_MS), bounds.hi - bounds.lo || MIN_SPAN_MS)
  // Keep `focus` at the same fraction of the new window.
  const lo = focus - (focus - view.lo) * (nextSpan / span)
  return clampWindow({ lo, hi: lo + nextSpan }, bounds)
}

/** Smallest drag, in pixels, that counts as a deliberate selection rather than a click. */
export const MIN_DRAG_PX = 3

/**
 * The window a rubber-band selection over the PLOT zooms to, from two x
 * positions in it.
 *
 * Returns null for a drag too short to be deliberate, so a plain click on the
 * chart leaves the view alone instead of zooming it to nothing.
 */
export function windowFromPlotDrag(
  x0: number,
  x1: number,
  plotL: number,
  plotW: number,
  view: TimeWindow,
  bounds: TimeWindow,
): TimeWindow | null {
  if (plotW <= 0) return null
  const a = Math.min(x0, x1)
  const b = Math.max(x0, x1)
  if (b - a < MIN_DRAG_PX) return null
  // Unlike the strip, the plot shows the CURRENT window, so a selection reads
  // against `view` — this is what lets the user zoom in repeatedly.
  const span = view.hi - view.lo
  const lo = view.lo + ((a - plotL) / plotW) * span
  const hi = view.lo + ((b - plotL) / plotW) * span
  return clampWindow({ lo, hi }, bounds)
}

/** Geometry of the range strip, as the painter laid it out. */
export interface RangeGeom {
  /** Left and right edge of the strip itself. */
  x0: number
  x1: number
  /** Top and bottom edge, for hit-testing the pointer's y. */
  y0: number
  y1: number
  /** Left and right edge of the highlighted window inside the strip. */
  win: { x0: number; x1: number }
}

/**
 * What a pointer at (px, py) is over in the range strip.
 *
 * `lo`/`hi` are the window's edges, which resize it; `move` is its body, which
 * drags it whole; `jump` is the strip outside the window, which recentres it.
 * Null means the pointer is not on the strip at all.
 */
export type RangeHit = 'lo' | 'hi' | 'move' | 'jump' | null

/** Half-width of an edge's grab zone: the drawn handle is 3px, this is reachable. */
const EDGE_GRAB_PX = 5

export function hitRange(r: RangeGeom | null, px: number, py: number): RangeHit {
  if (!r) return null
  // A few pixels of slack past each end, so the window can still be grabbed when
  // it sits flush against the edge of the strip.
  if (py < r.y0 || py > r.y1 || px < r.x0 - 6 || px > r.x1 + 6) return null
  if (Math.abs(px - r.win.x0) <= EDGE_GRAB_PX) return 'lo'
  if (Math.abs(px - r.win.x1) <= EDGE_GRAB_PX) return 'hi'
  if (px > r.win.x0 && px < r.win.x1) return 'move'
  return 'jump'
}

/** The timestamp a position on the range strip points at. */
function timeOnStrip(r: RangeGeom, px: number, bounds: TimeWindow): number {
  const frac = Math.min(1, Math.max(0, (px - r.x0) / (r.x1 - r.x0 || 1)))
  return bounds.lo + frac * (bounds.hi - bounds.lo)
}

/**
 * The window produced by dragging the range strip.
 *
 * `mode` is the hit the drag started on; `grab` is where inside the window the
 * pointer took hold, so a moved window does not snap its left edge to the
 * cursor. Resizing an edge keeps the other one fixed.
 */
export function windowFromRangeGrab(
  mode: Exclude<RangeHit, null | 'jump'>,
  r: RangeGeom,
  px: number,
  grab: number,
  view: TimeWindow,
  bounds: TimeWindow,
): TimeWindow {
  if (mode === 'move') {
    const span = view.hi - view.lo
    const lo = timeOnStrip(r, px - grab, bounds)
    return clampWindow({ lo, hi: lo + span }, bounds)
  }
  if (mode === 'lo') {
    const lo = Math.min(timeOnStrip(r, px, bounds), view.hi - MIN_SPAN_MS)
    return clampWindow({ lo: Math.max(lo, bounds.lo), hi: view.hi }, bounds)
  }
  const hi = Math.max(timeOnStrip(r, px, bounds), view.lo + MIN_SPAN_MS)
  return clampWindow({ lo: view.lo, hi: Math.min(hi, bounds.hi) }, bounds)
}

/**
 * The window after clicking the strip outside the current window: the span is
 * kept and recentred on the click, the way the overview's does it.
 */
export function windowFromRangeJump(
  r: RangeGeom,
  px: number,
  view: TimeWindow,
  bounds: TimeWindow,
): TimeWindow {
  const span = view.hi - view.lo
  const centre = timeOnStrip(r, px, bounds)
  return clampWindow({ lo: centre - span / 2, hi: centre + span / 2 }, bounds)
}

/**
 * Whether two extents describe the same record.
 *
 * A widget reloads whenever its tab becomes visible again, and reframing the
 * chart there would throw away the window the user had zoomed to. Comparing the
 * extents tells a genuine change of record — another patient, another visit —
 * from the same one arriving a second time.
 *
 * Exact equality: both sides are computed the same way from the same rows, so
 * an identical record yields identical numbers, and a tolerance would risk
 * calling two genuinely close records the same.
 */
export function sameBounds(a: TimeWindow | null, b: TimeWindow | null): boolean {
  if (!a || !b) return false
  return a.lo === b.lo && a.hi === b.hi
}

/** Whether a window covers its whole bounds — used to hide the "reset" affordance. */
export function isFullWindow(view: TimeWindow, bounds: TimeWindow): boolean {
  return view.lo <= bounds.lo && view.hi >= bounds.hi
}

/**
 * Nice-ish tick timestamps across a window.
 *
 * Picks the largest step from a fixed ladder that still yields at least two
 * ticks, so the axis reads in whole minutes/hours/days rather than arbitrary
 * fractions of the span.
 */
const TICK_STEPS = [
  1000, 5000, 15000, 30000,
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000,
  86_400_000, 2 * 86_400_000, 7 * 86_400_000, 30 * 86_400_000,
  90 * 86_400_000, 365 * 86_400_000,
]

export function axisTicks(view: TimeWindow, target: number): number[] {
  const span = view.hi - view.lo
  if (!(span > 0) || target < 1) return []
  const ideal = span / target
  const step = TICK_STEPS.find((s) => s >= ideal) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const ticks: number[] = []
  // Anchor on the step so labels land on round values, not on the window's edge.
  for (let t = Math.ceil(view.lo / step) * step; t <= view.hi; t += step) ticks.push(t)
  return ticks
}
