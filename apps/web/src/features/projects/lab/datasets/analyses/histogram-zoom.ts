/**
 * Drag-to-zoom over a histogram's bin axis.
 *
 * A drag selects bars, so the gesture is expressed in bin INDICES — but the window
 * it produces is a VALUE range [lo, hi]. That is what makes the zoom a real zoom:
 * the values inside it are re-binned into the widget's full bin count, rather than
 * the original bars being shown wider. It also survives rebinning, since the bounds
 * no longer refer to positions in a particular bin array.
 */

export interface ZoomWindow {
  /** Lower bound of the visible value range, inclusive. */
  lo: number
  /** Upper bound of the visible value range, inclusive. */
  hi: number
}

/** A drag spanning fewer bars than this reads as a click, not a zoom. */
const MIN_DRAG_BINS = 3

/**
 * Turn a drag between two bin indices into a value window, or null when the gesture
 * was too small to be deliberate. `binLowerBounds[i]` is the lower edge of bin i,
 * and `upperBound` the top of the last bin — together they map a bar back to values.
 */
export function windowFromDrag(
  fromIndex: number | null | undefined,
  toIndex: number | null | undefined,
  binLowerBounds: number[],
  upperBound: number,
): ZoomWindow | null {
  if (fromIndex == null || toIndex == null || binLowerBounds.length === 0) return null
  const lastIndex = binLowerBounds.length - 1
  const loIdx = Math.max(0, Math.min(fromIndex, toIndex))
  const hiIdx = Math.min(lastIndex, Math.max(fromIndex, toIndex))
  if (hiIdx - loIdx + 1 < MIN_DRAG_BINS) return null
  const lo = binLowerBounds[loIdx]
  // Include the whole of the last selected bin: its top is the next bin's floor,
  // or the overall upper bound when it is the final one.
  const hi = hiIdx < lastIndex ? binLowerBounds[hiIdx + 1] : upperBound
  if (!(hi > lo)) return null
  return { lo, hi }
}

/** Keep only the values inside the window (inclusive), or all of them when unzoomed. */
export function valuesInWindow(values: number[], window: ZoomWindow | null): number[] {
  if (!window) return values
  return values.filter((v) => v >= window.lo && v <= window.hi)
}

/**
 * How many bins to draw for a zoomed range: the configured count, but never more
 * than the number of distinct values it holds. Asking for 20 bins over the integers
 * 1..10 would leave every other bar empty — a comb suggesting gaps in the data that
 * do not exist.
 */
export function binCountForWindow(values: number[], configuredBins: number): number {
  if (values.length === 0) return configuredBins
  const distinct = new Set(values).size
  return Math.max(1, Math.min(configuredBins, distinct))
}

/** Whether a window is actually narrower than the data — used for the reset affordance. */
export function isZoomed(window: ZoomWindow | null | undefined): boolean {
  return window != null
}
