/** Share of published cells as a colour: green from 90 %, amber from 60 %, red below. */
export function yieldClass(pct: number): string {
  if (pct >= 90) return 'text-emerald-600 dark:text-emerald-400'
  if (pct >= 60) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}
