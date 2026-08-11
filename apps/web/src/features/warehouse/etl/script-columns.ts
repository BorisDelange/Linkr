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

/**
 * Where a card dragged from `fromIndex` lands when dropped on column `col`'s
 * empty space: at the END of that column, in single-sequence terms.
 *
 * Always `end - 1`, because `columnLengths` describes the layout BEFORE the card
 * is pulled out and the card itself always occupies one of the slots being
 * counted. Dropping into a LATER column, the card leaves from before the boundary
 * and everything after shifts down by one; dropping into an EARLIER one, the
 * boundary is already the first index past the column, so the last row is one
 * below it. Both come to the same index — verified by brute force against every
 * (card, column) pair rather than reasoned about, since the two directions look
 * like they should differ.
 */
export function columnDropIndex(columnLengths: number[], col: number): number {
  const endOfColumn = columnLengths
    .slice(0, col + 1)
    .reduce((n, len) => n + len, 0)
  return Math.max(0, endOfColumn - 1)
}

/**
 * Where a card lands when dropped on the zone ABOVE column `col`: at that
 * column's first row.
 *
 * Unlike `columnDropIndex` this needs no off-by-one correction. The first index
 * of a column is the sum of the columns before it, and a card arriving from
 * anywhere else is inserted at exactly that position.
 */
export function columnStartIndex(columnLengths: number[], col: number): number {
  return columnLengths.slice(0, col).reduce((n, len) => n + len, 0)
}

/**
 * The sequence index one column to the left (`dir` -1) or right (+1) of `index`,
 * keeping the same row within the column.
 *
 * Not simply `index ± columnLength`: the columns are balanced by spreading the
 * remainder over the leftmost ones, so they have DIFFERENT lengths and the step
 * depends on which column you start from. Returns `index` unchanged when there
 * is no column that way, so a caller can treat it as "no move".
 */
export function columnNeighbourIndex(
  columnLengths: number[],
  index: number,
  dir: -1 | 1,
): number {
  let start = 0
  for (let c = 0; c < columnLengths.length; c++) {
    const length = columnLengths[c]
    if (index < start + length) {
      const row = index - start
      const targetCol = c + dir
      if (targetCol < 0 || targetCol >= columnLengths.length) return index
      const targetStart = dir === 1 ? start + length : start - columnLengths[targetCol]
      // A shorter neighbouring column has no such row: land on its last card.
      return targetStart + Math.min(row, columnLengths[targetCol] - 1)
    }
    start += length
  }
  return index
}
