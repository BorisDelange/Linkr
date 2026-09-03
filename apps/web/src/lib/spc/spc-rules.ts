/**
 * Runs rules: the non-random patterns that stay INSIDE the control limits.
 *
 * A point beyond a limit is one kind of signal. A long run on one side of the
 * centre line, or a series that crosses it too rarely, is another — and it is
 * how a slow shift announces itself before any single point escapes.
 *
 * The trade-off to respect: every rule added raises sensitivity and lowers
 * specificity. Stack all eight Western Electric rules and a perfectly stable
 * process alarms constantly, which trains people to ignore the chart. Anhøj
 * (2015, PLoS ONE 10(3):e0121349) compared the published rule sets by likelihood
 * ratios on simulated series and found the two rules below dominate — crucially
 * because their thresholds SCALE WITH SERIES LENGTH, where the familiar "8 points
 * on one side" applies one fixed number to a series of any length.
 */

import type { ChartPoint, RunsRuleSet, SignalKind } from './spc-types'

/**
 * Longest acceptable run of consecutive points on one side of the centre line.
 * Anhøj's threshold: round(log2(n)) + 3. A run longer than this is a signal.
 */
export function maxAcceptableRun(n: number): number {
  if (n < 2) return Infinity
  return Math.round(Math.log2(n)) + 3
}

/**
 * Fewest acceptable crossings of the centre line, as the 5th percentile of the
 * binomial distribution of crossings for a random series of this length.
 *
 * Anhøj's table is well approximated by the normal quantile of a Binomial(n-1,
 * 0.5): mean (n-1)/2, sd √(n-1)/2, and the 5th percentile is 1.645 sd below.
 * Fewer crossings than this means the series wanders on one side too long.
 */
export function minAcceptableCrossings(n: number): number {
  if (n < 3) return 0
  const trials = n - 1
  const approx = trials / 2 - 1.645 * (Math.sqrt(trials) / 2)
  return Math.max(1, Math.floor(approx))
}

/** Sign of a point relative to the centre; 0 for a point exactly on it. */
function sideOf(p: ChartPoint): number {
  if (p.value > p.centre) return 1
  if (p.value < p.centre) return -1
  return 0
}

/**
 * Flag runs of points on one side of the centre line.
 *
 * Points sitting exactly ON the centre line break neither a run nor count
 * towards one: they carry no directional information, so including them would
 * manufacture runs that the data does not show.
 */
function flagRuns(points: ChartPoint[], maxRun: number, out: SignalKind[][]): void {
  let start = 0
  let side = 0
  const closeRun = (end: number) => {
    if (side !== 0 && end - start > maxRun) {
      for (let k = start; k < end; k++) if (sideOf(points[k]) !== 0) out[k].push('shift')
    }
  }
  for (let i = 0; i < points.length; i++) {
    const s = sideOf(points[i])
    if (s === 0) continue
    if (s !== side) {
      closeRun(i)
      side = s
      start = i
    }
  }
  closeRun(points.length)
}

/** Flag every point when the series crosses the centre line too rarely. */
function flagCrossings(points: ChartPoint[], minCrossings: number, out: SignalKind[][]): void {
  const sides = points.map(sideOf).filter(s => s !== 0)
  if (sides.length < 3) return
  let crossings = 0
  for (let i = 1; i < sides.length; i++) if (sides[i] !== sides[i - 1]) crossings++
  if (crossings < minCrossings) {
    // Too few crossings is a property of the whole series, not of one point, so
    // it is reported on every point rather than pinned to an arbitrary one.
    for (let i = 0; i < points.length; i++) out[i].push('few-crossings')
  }
}

/** Flag runs of `k` strictly monotone points — the trend rule of the R scripts. */
function flagTrend(points: ChartPoint[], k: number, out: SignalKind[][]): void {
  if (points.length < k) return
  for (let i = 0; i + k <= points.length; i++) {
    let up = true
    let down = true
    for (let j = i + 1; j < i + k; j++) {
      if (!(points[j].value > points[j - 1].value)) up = false
      if (!(points[j].value < points[j - 1].value)) down = false
    }
    if (up || down) for (let j = i; j < i + k; j++) out[j].push('trend')
  }
}

export interface RulesOptions {
  ruleSet: RunsRuleSet
  /** Run length for the `fixed` rule set. Ignored by `anhoj`. */
  runLength?: number
}

/**
 * Annotate points with their signals, in place, and return the same array.
 *
 * Out-of-limit points are flagged whatever the rule set: that rule is the chart
 * itself, not a sensitising addition. `none` disables only the runs rules.
 *
 * On an EWMA chart the runs rules are applied to the SMOOTHED series, which is
 * autocorrelated by construction — consecutive values share most of their
 * history, so runs appear more readily than on raw data. That is why they are
 * worth being able to switch off, and why the hand-written scripts colour them
 * as a weaker "alerte" than an out-of-limit "alarme".
 */
export function applyRules(points: ChartPoint[], opts: RulesOptions): ChartPoint[] {
  const out: SignalKind[][] = points.map(() => [])

  points.forEach((p, i) => {
    const beyond = (p.ucl !== null && p.value > p.ucl) || (p.lcl !== null && p.value < p.lcl)
    if (beyond) out[i].push('beyond-limits')
  })

  if (opts.ruleSet === 'anhoj') {
    flagRuns(points, maxAcceptableRun(points.length), out)
    flagCrossings(points, minAcceptableCrossings(points.length), out)
  } else if (opts.ruleSet === 'fixed') {
    const k = opts.runLength ?? 6
    flagRuns(points, k - 1, out)
    flagTrend(points, k, out)
  }

  points.forEach((p, i) => {
    p.signals = out[i]
  })
  return points
}
