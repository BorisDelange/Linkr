/**
 * Shapiro-Wilk normality test, and the test-choice rule that uses it.
 *
 * Why this exists: the Statistical tests plugin offered an `auto` mode that, for
 * two groups, always returned Welch's t-test — it never looked at the data. That
 * promises a judgement the code did not make. `auto` now means what it says.
 *
 * Implements Royston (1992), "Approximating the Shapiro-Wilk W-test for
 * non-normality", Applied Statistics 41(2), 333-343 — the same algorithm R's
 * `shapiro.test` uses, valid for 3 ≤ n ≤ 5000.
 */

/** Inverse standard normal CDF (Acklam's rational approximation, |ε| < 1.15e-9). */
function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) return NaN
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Standard normal CDF, via the Abramowitz-Stegun 7.1.26 erf approximation. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp(-z * z / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z > 0 ? 1 - p : p
}

export interface NormalityResult {
  /** Shapiro-Wilk W, in (0, 1]; 1 is perfectly normal. */
  w: number
  pValue: number
  n: number
}

/**
 * Shapiro-Wilk test for normality.
 *
 * Returns null when the sample is too small to judge (n < 3) or has no spread —
 * a constant column is not "non-normal", it is degenerate, and the caller must
 * decide what to do rather than be handed a p-value.
 */
export function shapiroWilk(values: number[]): NormalityResult | null {
  const x = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const n = x.length
  if (n < 3) return null
  if (x[0] === x[n - 1]) return null

  // n = 3 is a closed form, and must not go through the weights below: the
  // middle order statistic is exactly 0 there, so Royston's `phi` divides by
  // zero and every W comes out NaN.
  if (n === 3) {
    // The n = 3 weights are exactly (-1/√2, 0, 1/√2), so W reduces to
    // (x₃-x₁)² / 2·SS: 1 for equally spaced points, 0.75 at its minimum.
    const mean3 = (x[0] + x[1] + x[2]) / 3
    const ss = (x[0] - mean3) ** 2 + (x[1] - mean3) ** 2 + (x[2] - mean3) ** 2
    const w3 = Math.max(0, Math.min(1, (x[2] - x[0]) ** 2 / (2 * ss)))
    const pi6 = 1.909859
    const stqr = 1.047198
    return {
      w: w3,
      pValue: Math.max(0, Math.min(1, pi6 * (Math.asin(Math.sqrt(w3)) - stqr))),
      n,
    }
  }

  // Royston's approximation to the expected normal order statistics.
  const m: number[] = []
  for (let i = 1; i <= n; i++) m.push(normalQuantile((i - 0.375) / (n + 0.25)))
  const ssumm2 = m.reduce((s, v) => s + v * v, 0)
  const rsn = 1 / Math.sqrt(n)

  const a = new Array<number>(n).fill(0)
  const an = -2.706056 * rsn ** 5 + 4.434685 * rsn ** 4 - 2.071190 * rsn ** 3
    - 0.147981 * rsn ** 2 + 0.221157 * rsn + m[n - 1] / Math.sqrt(ssumm2)
  a[n - 1] = an
  a[0] = -an

  let phi: number
  if (n > 5) {
    const an1 = -3.582633 * rsn ** 5 + 5.682633 * rsn ** 4 - 1.752461 * rsn ** 3
      - 0.293762 * rsn ** 2 + 0.042981 * rsn + m[n - 2] / Math.sqrt(ssumm2)
    a[n - 2] = an1
    a[1] = -an1
    phi = (ssumm2 - 2 * m[n - 1] ** 2 - 2 * m[n - 2] ** 2) /
      (1 - 2 * an ** 2 - 2 * an1 ** 2)
  } else {
    phi = (ssumm2 - 2 * m[n - 1] ** 2) / (1 - 2 * an ** 2)
  }

  const lo = n > 5 ? 2 : 1
  for (let i = lo; i < n - lo; i++) a[i] = m[i] / Math.sqrt(phi)

  const mean = x.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += a[i] * x[i]
    den += (x[i] - mean) ** 2
  }
  if (den === 0) return null
  const w = Math.min(1, (num * num) / den)

  // Royston's normalizing transform, then a standard normal tail.
  const logn = Math.log(n)
  let pValue: number
  if (n <= 11) {
    const gamma = -2.273 + 0.459 * n
    const mu = 0.5440 - 0.39978 * n + 0.025054 * n ** 2 - 0.0006714 * n ** 3
    const sigma = Math.exp(1.3822 - 0.77857 * n + 0.062767 * n ** 2 - 0.0020322 * n ** 3)
    // The transform is undefined once W reaches gamma; that is an extremely
    // normal sample, so the tail probability is 1, not NaN.
    if (gamma - w <= 0) return { w, pValue: 1, n }
    pValue = 1 - normalCdf((-Math.log(gamma - w) - mu) / sigma)
  } else {
    const mu = -1.5861 - 0.31082 * logn - 0.083751 * logn ** 2 + 0.0038915 * logn ** 3
    const sigma = Math.exp(-0.4803 - 0.082676 * logn + 0.0030302 * logn ** 2)
    pValue = 1 - normalCdf((Math.log(1 - w) - mu) / sigma)
  }
  return { w, pValue: Math.max(0, Math.min(1, pValue)), n }
}

/** Above this many observations per group, normality is not tested — see below. */
export const NORMALITY_MAX_N = 5000

/**
 * Below this, a normality test has too little power to be worth acting on.
 *
 * Also sidesteps the weakest part of the approximation: Royston's small-sample
 * transform (n ≤ 11) saturates, returning p of exactly 0 or 1 rather than a
 * graded value. Useless as a reported figure, and we do not report it — but it
 * is one more reason not to let a handful of points pick the test.
 */
export const NORMALITY_MIN_N = 8

export interface NormalityVerdict {
  normal: boolean
  /** Why — for the tooltip that must accompany any automatically chosen test. */
  reason: 'not-tested-small' | 'not-tested-large' | 'tested'
  /** The smallest p across the groups tested, when `reason` is 'tested'. */
  pValue?: number
}

/**
 * Whether a set of groups may be treated as normally distributed.
 *
 * ALL groups must pass: a t-test compares them, so one skewed group is enough to
 * make the comparison suspect. The two abstentions are deliberate:
 *
 * - under `NORMALITY_MIN_N`, the test has so little power that it fails to
 *   reject almost everything, which would wave through genuinely skewed data.
 *   With that few points the robust choice is the safer one;
 * - over `NORMALITY_MAX_N`, Shapiro-Wilk rejects on deviations far too small to
 *   matter, and the CLT has made the mean's distribution normal anyway. Blindly
 *   following the p-value there would push every large sample onto a rank test
 *   for no gain.
 */
export function groupsLookNormal(groups: number[][]): NormalityVerdict {
  const usable = groups.filter((g) => g.length >= NORMALITY_MIN_N)
  if (usable.length !== groups.length) return { normal: false, reason: 'not-tested-small' }
  if (groups.some((g) => g.length > NORMALITY_MAX_N)) return { normal: true, reason: 'not-tested-large' }

  let worst = 1
  for (const g of usable) {
    const r = shapiroWilk(g)
    if (!r) return { normal: false, reason: 'not-tested-small' }
    worst = Math.min(worst, r.pValue)
  }
  return { normal: worst >= 0.05, reason: 'tested', pValue: worst }
}
