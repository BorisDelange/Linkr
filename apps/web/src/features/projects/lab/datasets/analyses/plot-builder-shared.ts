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

/** `val` as a number: numeric strings as such, ISO dates as epoch ms (naive ones
 *  read as UTC), anything else — blank included — NaN. Parity with the server's
 *  `_linkr_to_num` (pandas `format="ISO8601"`), so both sides call the same
 *  column numeric or categorical. */
export function toNumeric(val: unknown): number {
  if (val == null) return NaN
  if (typeof val === 'number') return val
  const s = String(val).trim()
  if (s === '') return NaN
  const n = Number(s)
  if (!isNaN(n)) return n
  return parseIsoUtc(s)
}

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}(?::?\d{2})?)?$/

function parseIsoUtc(s: string): number {
  const m = ISO_DATE.exec(s)
  if (!m) return NaN
  const [, day, time = '00:00', offset] = m
  const wallClock = Date.parse(`${day}T${time}Z`)
  // Date.parse rolls an impossible day over (Feb 30 → Mar 1); pandas rejects it.
  if (isNaN(wallClock) || !new Date(wallClock).toISOString().startsWith(day)) return NaN
  if (!offset || offset === 'Z') return wallClock
  const digits = offset.slice(1).replace(':', '')
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0')
  return wallClock - (offset[0] === '-' ? -1 : 1) * minutes * 60_000
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
