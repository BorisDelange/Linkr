import { extent } from '@/lib/numeric-extent'
import { orderCategories, type CategoryOrder } from './plot-category-order'
import { toNumeric } from './plot-builder-shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDateRange(values: number[]): boolean {
  if (values.length === 0) return false
  const mid = values[Math.floor(values.length / 2)]
  return mid > 1e11 && mid < 1e14
}

function formatBinLabel(val: number, dateMode: boolean, decimals = 1): string {
  if (dateMode) {
    const d = new Date(val)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }
  return val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Count-axis tick: always whole numbers, never scientific notation. */
export function formatCountTick(val: number | string): string {
  const n = typeof val === 'string' ? Number(val) : val
  if (isNaN(n)) return String(val)
  return Math.round(n).toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
}

export function formatDateTick(val: number | string): string {
  const n = typeof val === 'string' ? Number(val) : val
  if (isNaN(n)) return String(val)
  const d = new Date(n)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
}

/** Compute bin parameters: aligned start, width, and count.
 *  When binWidth is provided, bins start at a round multiple of binWidth. */
function computeBinParams(min: number, max: number, binMode: string, binsConfig: number, binWidthConfig: number, startAtZero = false) {
  const effectiveMin = (startAtZero && min > 0) ? 0 : min
  if (binMode === 'width' && binWidthConfig > 0) {
    const bw = binWidthConfig
    const alignedMin = Math.floor(effectiveMin / bw) * bw
    const alignedMax = Math.ceil(max / bw) * bw
    const n = Math.max(1, Math.round((alignedMax - alignedMin) / bw))
    return { start: alignedMin, binWidth: bw, count: n }
  }
  const range = max - effectiveMin
  return { start: effectiveMin, binWidth: range / binsConfig, count: binsConfig }
}

export function buildHistogramData(values: number[], binMode: string, binsConfig: number, binWidthConfig: number, startAtZero = false, decimals = 1) {
  if (values.length === 0) return []
  const { min, max } = extent(values)
  if (min === max) return [{ bin: formatBinLabel(min, isDateRange(values), decimals), count: values.length, lo: min, hi: min }]
  const dateMode = isDateRange(values)
  const { start, binWidth, count } = computeBinParams(min, max, binMode, binsConfig, binWidthConfig, startAtZero)
  // `lo`/`hi` carry each bar's numeric edges alongside its formatted label: the
  // label is rounded for display and can't be parsed back, but drag-to-zoom needs
  // the real bounds to re-bin the values it selected.
  const buckets: { bin: string; count: number; lo: number; hi: number }[] = []
  for (let i = 0; i < count; i++) {
    const lo = start + i * binWidth
    buckets.push({ bin: formatBinLabel(lo, dateMode, decimals), count: 0, lo, hi: lo + binWidth })
  }
  for (const v of values) {
    let idx = Math.floor((v - start) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= count) idx = count - 1
    buckets[idx].count++
  }
  return buckets
}

/** True when fewer than half of the non-empty values parse as numbers — i.e. the column is categorical text. */
export function isCategoricalColumn(rows: Record<string, unknown>[], col: string): boolean {
  let total = 0
  let numeric = 0
  for (const r of rows) {
    const v = r[col]
    if (v == null || v === '') continue
    total++
    if (!isNaN(toNumeric(v))) numeric++
    if (total >= 200) break
  }
  if (total === 0) return false
  return numeric / total < 0.5
}

/** Count occurrences of each category, split by group; ordered on the total over the groups. */
export function buildCategoricalGrouped(rows: Record<string, unknown>[], col: string, groupCol: string, groupNames: string[], order: CategoryOrder, custom: readonly string[]) {
  const counts = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const v = r[col]
    if (v == null || v === '') continue
    const key = String(v)
    const g = String(r[groupCol] ?? '')
    if (!groupNames.includes(g)) continue
    let entry = counts.get(key)
    if (!entry) {
      entry = Object.fromEntries(groupNames.map(n => [n, 0]))
      counts.set(key, entry)
    }
    entry[g]++
  }
  const total = (entry: Record<string, number>) => groupNames.reduce((s, n) => s + entry[n], 0)
  return orderCategories(Array.from(counts), ([bin]) => bin, ([, entry]) => total(entry), order, custom)
    .map(([bin, entry]) => ({ bin, ...entry }))
}

export function buildHistogramGrouped(
  rows: Record<string, unknown>[],
  xCol: string,
  groupCol: string,
  binMode: string,
  binsConfig: number,
  binWidthConfig: number,
  groupNames: string[],
  startAtZero = false,
  decimals = 1,
) {
  const allVals = rows.map(r => toNumeric(r[xCol])).filter(v => !isNaN(v))
  if (allVals.length === 0) return []
  const { min, max } = extent(allVals)
  const dateMode = isDateRange(allVals)
  if (min === max) return [{ bin: formatBinLabel(min, dateMode, decimals), ...Object.fromEntries(groupNames.map(g => [g, 0])) }]
  const { start, binWidth, count } = computeBinParams(min, max, binMode, binsConfig, binWidthConfig, startAtZero)

  const buckets: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const lo = start + i * binWidth
    const entry: Record<string, unknown> = { bin: formatBinLabel(lo, dateMode, decimals), lo, hi: lo + binWidth }
    for (const g of groupNames) entry[g] = 0
    buckets.push(entry)
  }

  for (const row of rows) {
    const v = toNumeric(row[xCol])
    if (isNaN(v)) continue
    let idx = Math.floor((v - start) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= count) idx = count - 1
    const g = String(row[groupCol] ?? '')
    if (g in (buckets[idx] as Record<string, unknown>)) {
      ;(buckets[idx] as Record<string, number>)[g]++
    }
  }
  return buckets
}
