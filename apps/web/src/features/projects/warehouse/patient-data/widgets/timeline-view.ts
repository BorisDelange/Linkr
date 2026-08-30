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

/** Shift a window by a pixel drag, given the plot width it was drawn at. */
export function panWindow(
  view: TimeWindow,
  bounds: TimeWindow,
  dxPx: number,
  plotW: number,
): TimeWindow {
  if (plotW <= 0) return view
  const span = view.hi - view.lo
  const dt = (dxPx / plotW) * span
  // Dragging right moves the window back in time, like pulling a sheet of paper.
  return clampWindow({ lo: view.lo - dt, hi: view.hi - dt }, bounds)
}

/**
 * The window a range-selector drag selects, from two x positions on the strip.
 *
 * Returns null for a drag too short to be deliberate — a click on the strip
 * would otherwise zoom to a zero-width window and blank the chart.
 */
export function windowFromRangeDrag(
  x0: number,
  x1: number,
  plotL: number,
  plotW: number,
  bounds: TimeWindow,
): TimeWindow | null {
  if (plotW <= 0) return null
  const a = Math.min(x0, x1)
  const b = Math.max(x0, x1)
  if (b - a < 3) return null
  const full = bounds.hi - bounds.lo
  const lo = bounds.lo + ((a - plotL) / plotW) * full
  const hi = bounds.lo + ((b - plotL) / plotW) * full
  return clampWindow({ lo, hi }, bounds)
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
