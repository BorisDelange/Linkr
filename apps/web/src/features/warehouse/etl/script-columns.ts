/**
 * Lay a pipeline's scripts out in newspaper columns.
 *
 * A pipeline is a SEQUENCE, so the eye has to be able to follow it. Filling the
 * grid row by row (1 2 3 / 4 5 6) breaks that: consecutive steps end up side by
 * side and the chain reads as a table. Filling column by column keeps each
 * column a run of consecutive steps — column 1 is 1…N, column 2 continues at
 * N+1 — which is the same top-to-bottom reading as the single-column layout,
 * only repeated across the width.
 */

/** How many columns fit, given the width available for the script cards. */
export function columnCountFor(width: number, scriptCount: number): number {
  // Below this a card cannot show a name plus its status and buttons without
  // truncating the name to uselessness.
  const MIN_COLUMN = 320
  if (width <= 0) return 1
  const fits = Math.max(1, Math.floor(width / MIN_COLUMN))
  // Never more columns than would leave a column nearly empty: three columns for
  // four scripts is worse than one, because the chain stops being a chain.
  const MIN_PER_COLUMN = 4
  return Math.max(1, Math.min(fits, Math.ceil(scriptCount / MIN_PER_COLUMN)))
}

/**
 * Split `items` into `columns` runs, filled top-to-bottom then left-to-right.
 *
 * The columns are balanced (the remainder spread over the leftmost ones) rather
 * than filling each to a fixed height, so the last column is never a lone card
 * beside three full ones.
 */
export function splitIntoColumns<T>(items: T[], columns: number): T[][] {
  if (columns <= 1 || items.length === 0) return [items]
  const perColumn = Math.floor(items.length / columns)
  const remainder = items.length % columns
  const out: T[][] = []
  let start = 0
  for (let c = 0; c < columns; c++) {
    const size = perColumn + (c < remainder ? 1 : 0)
    if (size === 0) continue
    out.push(items.slice(start, start + size))
    start += size
  }
  return out
}
