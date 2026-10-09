/**
 * The smallest and largest of the numbers in `lists` — `Infinity`/`-Infinity`
 * when there are none; NaN is skipped. Spreading one argument per row into
 * Math.min/max overflows the call stack past ~100k rows, hence a plain loop.
 */
export function extent(...lists: readonly (readonly number[])[]): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const list of lists) {
    for (const v of list) {
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return { min, max }
}
