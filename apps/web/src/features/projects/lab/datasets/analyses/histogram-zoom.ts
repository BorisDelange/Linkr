/**
 * Drag-to-zoom over a histogram's bin axis.
 *
 * The bin axis is categorical (one string label per bar), so a zoom window is a
 * range of bin INDICES rather than a numeric domain — which also makes it stable
 * when the bins themselves are recomputed.
 */

export interface ZoomWindow {
  /** First visible bin index, inclusive. */
  start: number
  /** Last visible bin index, inclusive. */
  end: number
}

/** A window narrower than this many bins is treated as a click, not a zoom, so a
 *  stray drag while reading the chart doesn't collapse it to one or two bars. */
const MIN_WINDOW_BINS = 3

/**
 * Turn a raw drag (two bin indices, in either order) into a window, or null when
 * the gesture was too small to be a deliberate zoom or fell outside the data.
 */
export function windowFromDrag(
  fromIndex: number | null | undefined,
  toIndex: number | null | undefined,
  binCount: number,
): ZoomWindow | null {
  if (fromIndex == null || toIndex == null || binCount <= 0) return null
  const lo = Math.max(0, Math.min(fromIndex, toIndex))
  const hi = Math.min(binCount - 1, Math.max(fromIndex, toIndex))
  if (hi - lo + 1 < MIN_WINDOW_BINS) return null
  return { start: lo, end: hi }
}

/**
 * Compose a new drag with the window already in effect: a zoom made while zoomed
 * is relative to what is on screen, so the indices have to be mapped back onto the
 * full dataset. Without this, zooming twice would jump back to the start.
 */
export function composeZoom(current: ZoomWindow | null, next: ZoomWindow): ZoomWindow {
  if (!current) return next
  return { start: current.start + next.start, end: current.start + next.end }
}

/** The visible slice of the data for a window (the whole array when unzoomed). */
export function sliceToWindow<T>(data: T[], window: ZoomWindow | null): T[] {
  if (!window) return data
  return data.slice(window.start, window.end + 1)
}

/** Whether a window actually hides anything — used to show the reset affordance. */
export function isZoomed(window: ZoomWindow | null, binCount: number): boolean {
  if (!window) return false
  return window.start > 0 || window.end < binCount - 1
}
