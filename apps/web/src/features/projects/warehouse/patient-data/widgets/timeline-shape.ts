/**
 * Which shape each timeline series takes, and which renderer can draw them all.
 *
 * Deliberately reads nothing but the schema mapping and the values themselves —
 * no table or column name is ever matched. A model that calls its concept
 * dictionary `d_items` and one that calls it `concept` must classify the same
 * way, so the signals are: does the value parse as a number, does the event carry
 * an end date, and how crowded are the points.
 *
 * Kept pure and separate from the widget because the rule decides what the user
 * sees and is worth testing on its own.
 */

/** How one concept's events are drawn. */
export type SeriesShape = 'line' | 'points' | 'bars'

/** Which renderer draws the whole widget. */
export type TimelineRenderer = 'dygraphs' | 'overview'

/** The user's choice; `auto` derives the renderer from the data. */
export type TimelineEngine = 'auto' | TimelineRenderer

/** What a series needs to expose for classification. */
export interface SeriesSample {
  conceptId: number
  /** Raw values as returned, in event order. */
  values: unknown[]
  /** Event timestamps in ms, used to judge crowding. */
  timestamps: number[]
  /** True when the source event table maps an end date: the event lasts. */
  durational: boolean
}

export interface SeriesShapeResult {
  conceptId: number
  shape: SeriesShape
  /** False when the values are not numbers — the y axis cannot be continuous. */
  numeric: boolean
}

/**
 * Share of non-empty values that parse as finite numbers.
 *
 * Blank and null are skipped rather than counted as failures: a mostly numeric
 * series with a few empty cells is still numeric. A series with nothing but
 * empties has no evidence either way and reports 0.
 */
export function numericRatio(values: unknown[]): number {
  let seen = 0
  let numeric = 0
  for (const v of values) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    seen++
    if (typeof v === 'number') {
      if (Number.isFinite(v)) numeric++
      continue
    }
    if (typeof v === 'bigint') {
      numeric++
      continue
    }
    const n = Number(v)
    if (Number.isFinite(n)) numeric++
  }
  return seen === 0 ? 0 : numeric / seen
}

/**
 * Above this share of numeric values, treat the series as a measurement.
 *
 * Set high because the two kinds do not overlap in practice: a charted vital is
 * numeric in every row, a categorical observation in none. The threshold is here
 * to tolerate stray junk in a numeric column, not to arbitrate a genuine mix.
 */
export const NUMERIC_SERIES_THRESHOLD = 0.9

/** Fewer points than this and a line has too little to connect: draw marks. */
export const SPARSE_SERIES_POINTS = 3

/**
 * The shape one series takes.
 *
 * An event that lasts is a bar whatever its value — a four-hour infusion is a
 * span, not a reading. Otherwise a numeric series is a line once it has enough
 * points to connect, and anything non-numeric is drawn as discrete marks.
 */
export function classifySeries(sample: SeriesSample): SeriesShapeResult {
  const numeric = numericRatio(sample.values) >= NUMERIC_SERIES_THRESHOLD
  if (sample.durational) return { conceptId: sample.conceptId, shape: 'bars', numeric }
  if (!numeric) return { conceptId: sample.conceptId, shape: 'points', numeric }
  const shape: SeriesShape =
    sample.timestamps.length >= SPARSE_SERIES_POINTS ? 'line' : 'points'
  return { conceptId: sample.conceptId, shape, numeric }
}

/**
 * The renderer for a set of series.
 *
 * Dygraph plots continuous numeric series on a shared y axis and nothing else,
 * so it is used exactly while it is capable: every series numeric, none lasting.
 * One categorical or durational series and the whole widget moves to the overview
 * renderer, which mixes lines, points and bars in one figure.
 *
 * With no series at all, Dygraph is the honest default — it is what an empty
 * timeline has always drawn, and switching renderers on an empty widget would
 * make it flicker as the first rows arrive.
 */
export function pickRenderer(shapes: SeriesShapeResult[]): TimelineRenderer {
  if (shapes.length === 0) return 'dygraphs'
  return shapes.every((s) => s.numeric && s.shape !== 'bars') ? 'dygraphs' : 'overview'
}

/** The renderer to use, honouring an explicit choice over the heuristic. */
export function resolveRenderer(
  engine: TimelineEngine | undefined,
  shapes: SeriesShapeResult[],
): TimelineRenderer {
  if (engine === 'dygraphs' || engine === 'overview') return engine
  return pickRenderer(shapes)
}
