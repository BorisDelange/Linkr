import { orderCategories, type CategoryOrder } from './plot-category-order'

// Server-computed chart payloads (parity with each sub-plot's front-only useMemo shape).
export interface PlotScatterSeries { name: string; data: { x: number; y: number }[] }
export interface PlotServerData {
  plotType: string
  groupNames: string[] | null
  series?: PlotScatterSeries[] | string[]
  data?: Record<string, unknown>[]
  isCategorical?: boolean
  colorByCategory?: boolean
  /** Rows dropped by the outlier filter, so server mode can report the same
   *  notice the client computes locally. */
  outliersExcluded?: number
  /** Plottable points before sampling, sent only when scatter/line was sampled. */
  pointsTotal?: number
}

export function toNumeric(val: unknown): number {
  if (val == null) return NaN
  if (typeof val === 'number') return val
  const s = String(val).trim()
  const n = Number(s)
  if (!isNaN(n)) return n
  const ts = Date.parse(s)
  if (!isNaN(ts)) return ts
  return NaN
}

export function formatNumericTick(decimals: number) {
  return (val: number | string): string => {
    const n = typeof val === 'string' ? Number(val) : val
    if (isNaN(n)) return String(val)
    // useGrouping spells out large numbers (4380) instead of scientific notation (4.38e+3)
    if (Number.isInteger(n)) return n.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true })
  }
}

/** `value` as a percentage of `total`, one decimal. */
export function sharePct(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) : '0'
}

export const NO_CUSTOM_ORDER: readonly string[] = []

/** Count occurrences of each unique category value, in the chosen category order. */
export function buildCategoricalData(rows: Record<string, unknown>[], col: string, order: CategoryOrder, custom: readonly string[]) {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const v = r[col]
    if (v == null || v === '') continue
    const key = String(v)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const data = Array.from(counts, ([bin, count]) => ({ bin, count }))
  return orderCategories(data, d => d.bin, d => d.count, order, custom)
}
