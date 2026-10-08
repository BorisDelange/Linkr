import { aggregateByEntity } from '@/lib/plugins/shared-styles'
import { toComparableString } from '@/lib/dataset-utils'

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantile(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

export function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

export function isEmptyVal(val: unknown): boolean {
  if (val == null) return true
  const s = String(val).trim().toLowerCase()
  return s === '' || s === 'na' || s === 'nan' || s === 'null' || s === 'none'
}

export function computeAggregate(values: number[], fn: string): number | null {
  if (values.length === 0) return null
  switch (fn) {
    case 'mean': return values.reduce((s, v) => s + v, 0) / values.length
    case 'median': return median(values)
    case 'min': return values.reduce((m, v) => (v < m ? v : m))
    case 'max': return values.reduce((m, v) => (v > m ? v : m))
    case 'sum': return values.reduce((s, v) => s + v, 0)
    case 'count': return values.length
    case 'sd': return stddev(values)
    case 'q1': return quantile(values, 0.25)
    case 'q3': return quantile(values, 0.75)
    case 'iqr': return quantile(values, 0.75) - quantile(values, 0.25)
    default: return null
  }
}

export interface KpiValueOptions {
  columnId: string
  uniquePerId?: string
  uniqueAggregation: string
  aggregate: string
  targetValue: string
  excludeNA: boolean
}

export interface ProportionResult {
  result: number
  n: number
  matchCount: number
  resolvedTarget: string
}

/** The configured target, or the most frequent value when none is set. */
export function resolveTarget(values: unknown[], targetValue: string): string {
  if (targetValue) return toComparableString(targetValue)
  const counts = new Map<string, number>()
  let best = ''
  let bestCount = 0
  for (const v of values) {
    const k = toComparableString(v)
    const c = (counts.get(k) ?? 0) + 1
    counts.set(k, c)
    if (c > bestCount) { bestCount = c; best = k }
  }
  return best
}

/** One row per entity (when "Unique per" is set), then optionally without empty values. */
export function kpiMetricRows(rows: Record<string, unknown>[], o: KpiValueOptions): Record<string, unknown>[] {
  const source = o.uniquePerId
    ? aggregateByEntity(rows, o.uniquePerId, o.uniqueAggregation === 'any' ? 'first' : o.uniqueAggregation)
    : rows
  return o.excludeNA ? source.filter(r => !isEmptyVal(r[o.columnId])) : source
}

/**
 * "Any row matches": in a long table (one row per event), an entity counts as a
 * match when one of its rows holds the target, and an entity with no value at
 * all stays in the denominator as a non-match — "% of patients with a BSI" over
 * every patient, not only over those with an infection-related row. Without a
 * target, any non-empty value is a match.
 * Server mirror: the `any` branch of _linkr_print_kpi in render/key_indicator.py.
 */
export function anyRowProportion(rows: Record<string, unknown>[], o: KpiValueOptions & { uniquePerId: string }): ProportionResult | null {
  // No target: any value counts ("% of patients with at least one antibiotic").
  const resolvedTarget = o.targetValue ? toComparableString(o.targetValue) : ''
  const matched = new Map<unknown, boolean>()
  for (const row of rows) {
    const key = row[o.uniquePerId]
    if (key == null) continue
    const v = row[o.columnId]
    const hit = !isEmptyVal(v) && (!resolvedTarget || toComparableString(v) === resolvedTarget)
    matched.set(key, (matched.get(key) ?? false) || hit)
  }
  const n = matched.size
  if (n === 0) return null
  let matchCount = 0
  for (const hit of matched.values()) if (hit) matchCount++
  return { result: (matchCount / n) * 100, n, matchCount, resolvedTarget }
}

export function computeProportion(rows: Record<string, unknown>[], metricRows: Record<string, unknown>[], o: KpiValueOptions): ProportionResult | null {
  if (o.uniquePerId && o.uniqueAggregation === 'any') return anyRowProportion(rows, { ...o, uniquePerId: o.uniquePerId })
  const rawValues = metricRows.map(r => r[o.columnId]).filter(v => v != null)
  if (rawValues.length === 0) return null
  const resolvedTarget = resolveTarget(rawValues, o.targetValue)
  const matchCount = rawValues.filter(v => toComparableString(v) === resolvedTarget).length
  return { result: (matchCount / rawValues.length) * 100, n: rawValues.length, matchCount, resolvedTarget }
}

export function computeNumeric(metricRows: Record<string, unknown>[], o: KpiValueOptions) {
  const vals: number[] = []
  let nonNull = 0
  let targetMatches = 0
  const target = toComparableString(o.targetValue ?? '')
  for (const row of metricRows) {
    const raw = row[o.columnId]
    if (isEmptyVal(raw)) continue
    nonNull++
    if (target && toComparableString(raw) === target) targetMatches++
    const num = typeof raw === 'number' ? raw : Number(raw)
    if (!isNaN(num)) vals.push(num)
  }
  // "Count" = rows in scope (all rows when NA are kept, else non-empty only), or rows
  // matching the target value when one is chosen. Valid even for categorical columns.
  const result = o.aggregate === 'count'
    ? (target ? targetMatches : (o.excludeNA ? nonNull : metricRows.length))
    : computeAggregate(vals, o.aggregate)
  return { values: vals, result, nonNull, targetMatches, target }
}

/** The headline value alone, for a comparison window. */
export function computeKpiValue(rows: Record<string, unknown>[], o: KpiValueOptions): number | null {
  const metricRows = kpiMetricRows(rows, o)
  if (o.aggregate === 'proportion') return computeProportion(rows, metricRows, o)?.result ?? null
  return computeNumeric(metricRows, o).result
}

/**
 * Change against the previous period: percentage points for a proportion (a rate
 * going from 20 % to 25 % is "+5 pts", not "+25 %"), relative change otherwise.
 * Null when the previous value can't anchor a comparison.
 */
export function kpiTrendDelta(current: number | null, previous: number | null, isProportion: boolean): number | null {
  if (current === null || previous === null) return null
  if (isProportion) return current - previous
  if (previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

/** Five-number summary a box plot is drawn from (Tukey whiskers). */
export interface BoxStats {
  min: number
  q1: number
  median: number
  q3: number
  max: number
  mean: number
}

/**
 * Five-number summary with Tukey whiskers (Q1−1.5·IQR / Q3+1.5·IQR, pulled back to
 * real data). Server mirror: `_linkr_boxplot_stats` in
 * apps/api/app/services/execution/render/key_indicator.py — the quartiles must stay
 * identical on both sides or the same column would draw two different boxes.
 */
export function computeBoxStats(values: number[]): BoxStats | null {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return null
  const q1 = quantile(s, 0.25)
  const median = quantile(s, 0.5)
  const q3 = quantile(s, 0.75)
  const iqr = q3 - q1
  return {
    min: Math.max(s[0], q1 - 1.5 * iqr),
    q1,
    median,
    q3,
    max: Math.min(s[n - 1], q3 + 1.5 * iqr),
    mean: s.reduce((a, b) => a + b, 0) / n,
  }
}
