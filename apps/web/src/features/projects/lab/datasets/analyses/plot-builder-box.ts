import { orderCategories, type CategoryOrder } from './plot-category-order'

/** Plot Builder boxplot/violin data: per-category stats, category ordering,
 *  capped category count. Server parity: `_linkr_print_plot` boxplot branch in
 *  apps/api/app/services/execution/render/plot_builder.py. */

export const MAX_BOX_CATEGORIES = 20

export interface BoxStats { min: number; q1: number; median: number; q3: number; max: number; mean: number }

export interface BoxplotData {
  name: string
  stats: BoxStats
  values: number[]
}

export function computeBoxplotStats(values: number[]): BoxStats | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]
  const median = sorted[Math.floor(sorted.length * 0.5)]
  const q3 = sorted[Math.floor(sorted.length * 0.75)]
  const iqr = q3 - q1
  const whiskerLow = Math.max(sorted[0], q1 - 1.5 * iqr)
  const whiskerHigh = Math.min(sorted[sorted.length - 1], q3 + 1.5 * iqr)
  return { min: whiskerLow, q1, median, q3, max: whiskerHigh, mean: values.reduce((s, v) => s + v, 0) / values.length }
}

/** Categories ordered by `order` (value = the median; `data` = first seen).
 *  Ordering happens before the cap, so a sorted chart keeps its top medians
 *  rather than the first categories met. */
export function buildBoxplotGroups(
  groups: Iterable<[string, number[]]>,
  order: CategoryOrder,
  custom: readonly string[] = [],
): BoxplotData[] {
  const out: BoxplotData[] = []
  for (const [name, values] of groups) {
    const stats = computeBoxplotStats(values)
    if (stats) out.push({ name, stats, values })
  }
  return orderCategories(out, d => d.name, d => d.stats.median, order, custom).slice(0, MAX_BOX_CATEGORIES)
}
