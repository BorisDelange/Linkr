/**
 * Control limits, one function per chart type.
 *
 * Every function here takes aggregated periods and returns plotted points with
 * their own limits. Three invariants hold across all of them and an edit that
 * breaks one produces a chart that looks fine and lies:
 *
 * 1. **Limits vary with the denominator.** A month with 40 admissions gets wider
 *    limits than one with 400. The limits are a staircase, not two horizontal
 *    lines. Flat limits over varying denominators is the most common error in
 *    hand-made hospital charts.
 * 2. **The centre line is fitted on the BASELINE only** (Phase I), then held
 *    fixed while later points are judged against it (Phase II). Refitting on all
 *    data lets a slow drift carry the limits along with it, so the chart absorbs
 *    the very deterioration it exists to detect.
 * 3. **Sigma comes from the distributional model**, never from the scatter of
 *    the points. See `spc-types.ts`.
 *
 * Formulas follow Mohammed, Worthington & Woodall (2008), Qual Saf Health Care
 * 17:137-145, and are cross-checked against the `qicharts2` R package in the
 * tests. Laney's prime charts follow Laney (2002), Quality Engineering 14:531-537.
 */

import type { ChartPoint, PeriodPoint, SpcResult, SpcWarning } from './spc-types'

/**
 * d2 for a moving range of 2 — the bias-correction constant that turns a mean
 * moving range into an estimate of sigma. Fixed by the subgroup size, not a
 * tuning knob.
 */
const D2_MR2 = 1.128

/** D4 for n=2: the upper limit multiplier of a moving-range chart. */
export const D4_MR2 = 3.267

/** Mean of the finite values, or 0 for an empty list. */
function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((a, b) => a + b, 0) / finite.length
}

/**
 * Sigma estimated from the average moving range — the within-series estimator.
 *
 * Deliberately NOT the standard deviation of the values: a sustained shift
 * inflates the SD, which would widen the limits until the shift no longer
 * signals. Consecutive differences are blind to a step change, which is exactly
 * what makes them the right estimator for a chart meant to detect one.
 */
export function sigmaFromMovingRange(values: number[]): number {
  if (values.length < 2) return 0
  const ranges: number[] = []
  for (let i = 1; i < values.length; i++) ranges.push(Math.abs(values[i] - values[i - 1]))
  return mean(ranges) / D2_MR2
}

/** Split the periods into the baseline the limits are fitted on, and the rest. */
export interface Baseline {
  /** Index of the first period NOT in the baseline; equals length when all are. */
  end: number
}

/**
 * Laney's dispersion factor σ_z — the whole point of the P′ and U′ charts.
 *
 * With large denominators (a p-chart over 1200 admissions a month) binomial
 * limits become so tight that nearly every point falls outside them — not
 * because the process is unstable, but because real between-period variation
 * exceeds what the binomial allows. Laney's correction rescales the limits by
 * the observed dispersion of the z-scores, and collapses to the ordinary chart
 * (σ_z ≈ 1) when the data are as dispersed as the model predicts.
 *
 * Returns 1 when there are too few points to estimate it, so a prime chart on a
 * short series degrades to its plain counterpart rather than to nonsense.
 */
export function laneySigmaZ(
  points: PeriodPoint[],
  centre: number,
  sigmaOf: (n: number) => number,
): number {
  if (points.length < 2) return 1
  const z = points.map(p => {
    const sigma = sigmaOf(p.n)
    if (!Number.isFinite(sigma) || sigma === 0) return 0
    return (p.y / p.n - centre) / sigma
  })
  const sz = sigmaFromMovingRange(z)
  // A degenerate estimate (a constant series, a single moving range of 0) must
  // not collapse the limits to zero width: fall back to the unadjusted chart.
  return Number.isFinite(sz) && sz > 0 ? sz : 1
}

interface BuildOptions {
  points: PeriodPoint[]
  baseline: Baseline
  /** Limit width in sigmas. 3 is the Shewhart convention. */
  sigmaWidth: number
  /** A fixed centre line, when the user imposes a target instead of fitting one. */
  target?: number
}

/** Assemble a point, clamping the limits to the statistic's natural floor/ceiling. */
function makePoint(
  p: PeriodPoint,
  value: number,
  centre: number,
  sigma: number,
  sigmaWidth: number,
  bounds: { min?: number; max?: number },
  baseline: boolean,
): ChartPoint {
  let ucl: number | null = centre + sigmaWidth * sigma
  let lcl: number | null = centre - sigmaWidth * sigma
  if (bounds.max !== undefined) ucl = Math.min(ucl, bounds.max)
  if (bounds.min !== undefined) lcl = Math.max(lcl, bounds.min)
  if (!Number.isFinite(ucl)) ucl = null
  if (!Number.isFinite(lcl)) lcl = null
  return {
    date: p.date,
    value,
    numerator: p.y,
    denominator: p.n,
    centre,
    ucl,
    lcl,
    signals: [],
    baseline,
  }
}

/** Weighted centre of a ratio chart: total numerator over total denominator. */
function pooledCentre(points: PeriodPoint[]): number {
  const sy = points.reduce((a, p) => a + p.y, 0)
  const sn = points.reduce((a, p) => a + p.n, 0)
  return sn > 0 ? sy / sn : 0
}

/**
 * p-chart — a proportion of cases, binomial.
 * Centre: pooled p̄. Sigma: √(p̄(1-p̄)/n_t). Limits clamped to [0, 1].
 */
export function buildPChart(opts: BuildOptions & { prime?: boolean }): SpcResult {
  const { points, baseline, sigmaWidth, target, prime } = opts
  const base = points.slice(0, baseline.end)
  const centre = target ?? pooledCentre(base)
  const sigmaOf = (n: number) => (n > 0 ? Math.sqrt((centre * (1 - centre)) / n) : 0)
  const sigmaZ = prime ? laneySigmaZ(base, centre, sigmaOf) : 1
  const built = points.map((p, i) =>
    makePoint(p, p.n > 0 ? p.y / p.n : 0, centre, sigmaOf(p.n) * sigmaZ, sigmaWidth, { min: 0, max: 1 }, i < baseline.end),
  )
  const warnings: SpcWarning[] = []
  if (!prime && sigmaZ === 1) {
    const observed = laneySigmaZ(base, centre, sigmaOf)
    if (observed > 1.2) warnings.push({ code: 'overdispersion-prefer-prime', detail: observed.toFixed(2) })
  }
  return {
    chartType: prime ? 'p-prime' : 'p',
    points: built,
    centre,
    sigmaZ: prime ? sigmaZ : undefined,
    baselineCount: baseline.end,
    warnings,
  }
}

/**
 * u-chart — events per unit of exposure, Poisson.
 * Centre: pooled rate × basis. Sigma: √(ū·basis/n_t). LCL clamped to 0, no ceiling.
 */
export function buildUChart(opts: BuildOptions & { basis: number; prime?: boolean }): SpcResult {
  const { points, baseline, sigmaWidth, target, basis, prime } = opts
  const base = points.slice(0, baseline.end)
  const centre = target ?? pooledCentre(base) * basis
  const sigmaOf = (n: number) => (n > 0 ? Math.sqrt((centre * basis) / n) : 0)
  // laneySigmaZ divides by n to form the rate, so scale its sigma to the same
  // per-unit scale the raw ratio uses.
  const sigmaZ = prime
    ? laneySigmaZ(base, centre / basis, (n: number) => (n > 0 ? Math.sqrt(centre / (basis * n)) : 0))
    : 1
  const built = points.map((p, i) =>
    makePoint(p, p.n > 0 ? (p.y / p.n) * basis : 0, centre, sigmaOf(p.n) * sigmaZ, sigmaWidth, { min: 0 }, i < baseline.end),
  )
  return {
    chartType: prime ? 'u-prime' : 'u',
    points: built,
    centre,
    sigmaZ: prime ? sigmaZ : undefined,
    baselineCount: baseline.end,
    warnings: [],
  }
}

/**
 * c-chart — a raw count with a constant area of opportunity, Poisson.
 * Centre: mean count. Sigma: √c̄, constant. LCL clamped to 0.
 */
export function buildCChart(opts: BuildOptions): SpcResult {
  const { points, baseline, sigmaWidth, target } = opts
  const base = points.slice(0, baseline.end)
  const centre = target ?? mean(base.map(p => p.y))
  const sigma = Math.sqrt(Math.max(centre, 0))
  const built = points.map((p, i) => makePoint(p, p.y, centre, sigma, sigmaWidth, { min: 0 }, i < baseline.end))
  return { chartType: 'c', points: built, centre, baselineCount: baseline.end, warnings: [] }
}

/**
 * np-chart — a count of events with a roughly constant denominator, binomial.
 * Centre: n̄·p̄. Sigma: √(n̄·p̄(1-p̄)), constant — which is why it needs equal n.
 */
export function buildNpChart(opts: BuildOptions): SpcResult {
  const { points, baseline, sigmaWidth, target } = opts
  const base = points.slice(0, baseline.end)
  const nBar = mean(base.map(p => p.n))
  const pBar = pooledCentre(base)
  const centre = target ?? nBar * pBar
  const sigma = Math.sqrt(Math.max(nBar * pBar * (1 - pBar), 0))
  const built = points.map((p, i) => makePoint(p, p.y, centre, sigma, sigmaWidth, { min: 0 }, i < baseline.end))
  return { chartType: 'np', points: built, centre, baselineCount: baseline.end, warnings: [] }
}

/**
 * I-chart (individuals) — one measurement per period, Gaussian.
 * Sigma from the average moving range, so a sustained shift does not widen the
 * limits until it stops signalling.
 */
export function buildIChart(opts: BuildOptions): SpcResult {
  const { points, baseline, sigmaWidth, target } = opts
  const base = points.slice(0, baseline.end)
  const values = base.map(p => p.y)
  const centre = target ?? mean(values)
  const sigma = sigmaFromMovingRange(values)
  const built = points.map((p, i) => makePoint(p, p.y, centre, sigma, sigmaWidth, {}, i < baseline.end))
  return { chartType: 'i-mr', points: built, centre, baselineCount: baseline.end, warnings: [] }
}

/**
 * g-chart — cases (or days) between rare events, geometric.
 *
 * For an event a few times a year, a rate per 1000 days computed on two events a
 * month is noise plotted with authority. The g-chart charts the INTERVAL between
 * events instead, and the line going UP means improvement.
 *
 * Sigma of a geometric with mean m is √(m(m+1)). The lower limit is usually 0
 * and the upper limit is what carries the signal — the reverse of most charts.
 */
export function buildGChart(opts: BuildOptions): SpcResult {
  const { points, baseline, sigmaWidth, target } = opts
  const base = points.slice(0, baseline.end)
  const centre = target ?? mean(base.map(p => p.y))
  const sigma = Math.sqrt(Math.max(centre * (centre + 1), 0))
  const built = points.map((p, i) => makePoint(p, p.y, centre, sigma, sigmaWidth, { min: 0 }, i < baseline.end))
  return { chartType: 'g', points: built, centre, baselineCount: baseline.end, warnings: [] }
}

/**
 * t-chart — TIME between rare events (Nelson 1994).
 *
 * The continuous sibling of the g-chart. Intervals are strongly right-skewed, so
 * limits computed on the raw scale would put the LCL below zero and the UCL far
 * too high. The chart normalises with Y = T^(1/3.6), fits ordinary individuals
 * limits there, and raises them back to the power 3.6 — so the limits are
 * asymmetric on the original scale, which is correct for a waiting time.
 */
const T_CHART_EXPONENT = 3.6

export function buildTChart(opts: BuildOptions): SpcResult {
  const { points, baseline, sigmaWidth, target } = opts
  const toY = (t: number) => Math.pow(Math.max(t, 0), 1 / T_CHART_EXPONENT)
  const back = (y: number) => Math.pow(Math.max(y, 0), T_CHART_EXPONENT)
  const base = points.slice(0, baseline.end)
  const ys = base.map(p => toY(p.y))
  const centreY = target !== undefined ? toY(target) : mean(ys)
  const sigmaY = sigmaFromMovingRange(ys)
  const centre = back(centreY)
  const built = points.map((p, i) => ({
    date: p.date,
    value: p.y,
    numerator: p.y,
    denominator: p.n,
    centre,
    ucl: back(centreY + sigmaWidth * sigmaY),
    lcl: back(Math.max(centreY - sigmaWidth * sigmaY, 0)),
    signals: [],
    baseline: i < baseline.end,
  }))
  return { chartType: 't', points: built, centre, baselineCount: baseline.end, warnings: [] }
}

/**
 * EWMA — exponentially weighted moving average.
 *
 * Detects a small sustained shift (0.5-1σ) far sooner than a Shewhart chart, at
 * the cost of a line that no longer shows the raw data. λ = 0.2 is the practical
 * convention; smaller λ means more memory and slower reaction to a real jump.
 *
 * The variance uses the EXACT recursive form rather than its asymptotic limit,
 * which is what makes the first few points' limits correctly wider — with the
 * asymptotic form an early point is judged against limits that assume a history
 * the chart does not yet have.
 */
export function buildEwmaChart(
  opts: BuildOptions & {
    lambda: number
    /** Per-period variance of the plotted statistic, from its distribution. */
    varianceOf: (p: PeriodPoint) => number
    /** The statistic itself (a proportion, a rate, a mean). */
    valueOf: (p: PeriodPoint) => number
    /** Floor/ceiling of the statistic, e.g. [0,1] for a proportion. */
    bounds?: { min?: number; max?: number }
  },
): SpcResult {
  const { points, baseline, sigmaWidth, target, lambda, varianceOf, valueOf, bounds = {} } = opts
  const base = points.slice(0, baseline.end)
  const centre = target ?? mean(base.map(valueOf))

  let z = centre
  let varZ = 0
  const built = points.map((p, i) => {
    const observed = valueOf(p)
    z = lambda * observed + (1 - lambda) * z
    varZ = lambda * lambda * varianceOf(p) + (1 - lambda) * (1 - lambda) * varZ
    const sigma = Math.sqrt(Math.max(varZ, 0))
    const point = makePoint(p, z, centre, sigma, sigmaWidth, bounds, i < baseline.end)
    // The plotted value is the smoothed z, but the tooltip should still show
    // what actually happened in the period.
    point.numerator = p.y
    point.denominator = p.n
    return point
  })
  return { chartType: 'ewma', points: built, centre, baselineCount: baseline.end, warnings: [] }
}
