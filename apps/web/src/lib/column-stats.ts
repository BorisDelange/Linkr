import { niceStep } from '@/lib/chart-ticks'

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export function computeNumericStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, std: 0, q1: 0, q3: 0, iqr: 0, n: 0, sorted }
  }
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  const min = sorted[0]
  const max = sorted[n - 1]
  const median = percentile(sorted, 50)
  const q1 = percentile(sorted, 25)
  const q3 = percentile(sorted, 75)
  const iqr = q3 - q1

  return { min, max, mean, median, std, q1, q3, iqr, n, sorted }
}

/** A histogram bar: numeric bin low `x` (for a numeric axis with nice ticks),
 * a rounded string `label` (tooltip), the `count`, and its `pct`. */
export interface HistBin { x: number; label: string; count: number; pct: number }

export function roundBinLabel(lo: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return lo.toFixed(decimals)
}

export function buildHistogram(sorted: number[], bins: number): HistBin[] {
  if (sorted.length === 0) return []
  const dataMin = sorted[0]
  const dataMax = sorted[sorted.length - 1]
  // A non-finite bound (±Infinity slipped past the caller's filter) makes the
  // step 1 and `lo < Infinity` never terminate — bail rather than freeze the tab.
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return []
  if (dataMin === dataMax) return [{ x: dataMin, label: String(dataMin), count: sorted.length, pct: 100 }]

  // "Nice bins": round the start and step to readable values so bars land on round ticks.
  const step = niceStep((dataMax - dataMin) / bins)
  const start = Math.floor(dataMin / step) * step
  const result: HistBin[] = []
  for (let lo = start; lo < dataMax; lo += step) {
    const isLast = lo + step >= dataMax
    const hi = lo + step
    const count = sorted.filter((v) => v >= lo && (isLast ? v <= hi : v < hi)).length
    result.push({ x: lo, label: roundBinLabel(lo, step), count, pct: (count / sorted.length) * 100 })
  }
  return result
}
