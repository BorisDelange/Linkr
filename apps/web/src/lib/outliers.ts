import { percentile } from '@/lib/column-stats'

/** How to decide a value is an outlier. `none` disables the filter entirely. */
export type OutlierMethod = 'none' | 'iqr' | 'sd' | 'percentile'

/** Default coefficient per method: Tukey's 1.5×IQR, the 3σ rule, and the 1st/99th
 *  percentiles. The config field's meaning changes with the method, so the default
 *  has to follow it. */
export const OUTLIER_DEFAULT_COEF: Record<Exclude<OutlierMethod, 'none'>, number> = {
  iqr: 1.5,
  sd: 3,
  percentile: 1,
}

/**
 * Inclusive [lo, hi] bounds outside which a value counts as an outlier, or null
 * when nothing should be excluded (method 'none', no data, or a degenerate spread
 * — a zero IQR or SD would otherwise reject every value but the mode).
 *
 * Mirrored server-side by `_linkr_outlier_bounds` in
 * apps/api/app/services/execution/render/plot_builder.py — keep both in step.
 */
export function outlierBounds(
  values: number[],
  method: OutlierMethod,
  coef: number,
): { lo: number; hi: number } | null {
  if (method === 'none') return null
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return null
  const sorted = [...finite].sort((a, b) => a - b)

  if (method === 'iqr') {
    const q1 = percentile(sorted, 25)
    const q3 = percentile(sorted, 75)
    const iqr = q3 - q1
    if (iqr <= 0) return null
    return { lo: q1 - coef * iqr, hi: q3 + coef * iqr }
  }

  if (method === 'sd') {
    const n = sorted.length
    const mean = sorted.reduce((a, b) => a + b, 0) / n
    const sd = Math.sqrt(sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n)
    if (sd <= 0) return null
    return { lo: mean - coef * sd, hi: mean + coef * sd }
  }

  // percentile: coef is the tail percentage cut from each side.
  const p = Math.min(Math.max(coef, 0), 50)
  if (p <= 0) return null
  return { lo: percentile(sorted, p), hi: percentile(sorted, 100 - p) }
}

export function isWithinBounds(value: number, bounds: { lo: number; hi: number } | null): boolean {
  if (!bounds) return true
  return value >= bounds.lo && value <= bounds.hi
}
