import { describe, it, expect } from 'vitest'
import {
  buildCChart,
  buildEwmaChart,
  buildGChart,
  buildIChart,
  buildNpChart,
  buildPChart,
  buildTChart,
  buildUChart,
  laneySigmaZ,
  sigmaFromMovingRange,
  D4_MR2,
} from './spc-limits'
import type { PeriodPoint } from './spc-types'

/** Periods from parallel arrays, dated one month apart from 2024-01. */
function periods(y: number[], n: number[]): PeriodPoint[] {
  return y.map((value, i) => ({
    date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
    y: value,
    n: n[i],
  }))
}

const ALL = (len: number) => ({ end: len })

describe('sigmaFromMovingRange', () => {
  it('estimates sigma as the mean moving range over d2', () => {
    // Ranges are all 2 → MRbar = 2 → sigma = 2 / 1.128
    expect(sigmaFromMovingRange([10, 12, 10, 12, 10])).toBeCloseTo(2 / 1.128, 10)
  })

  it('is 0 below two points, where no range exists', () => {
    expect(sigmaFromMovingRange([5])).toBe(0)
    expect(sigmaFromMovingRange([])).toBe(0)
  })

  it('ignores a sustained shift, unlike a standard deviation', () => {
    // Two stable levels: the SD is large, but consecutive differences are 0
    // except at the single step, so the limits stay tight enough to flag it.
    const shifted = [10, 10, 10, 10, 20, 20, 20, 20]
    const sd = Math.sqrt(
      shifted.reduce((a, b) => a + (b - 15) ** 2, 0) / (shifted.length - 1),
    )
    expect(sigmaFromMovingRange(shifted)).toBeLessThan(sd)
  })
})

describe('buildPChart', () => {
  // Reference values computed independently: p̄ = 62/1235 = 0.0502024...
  const y = [5, 3, 8, 4, 6, 2, 7, 5, 4, 6, 9, 3]
  const n = [100, 110, 95, 105, 100, 90, 115, 100, 105, 95, 120, 100]

  it('centres on the pooled proportion, not the mean of proportions', () => {
    const r = buildPChart({ points: periods(y, n), baseline: ALL(12), sigmaWidth: 3 })
    expect(r.centre).toBeCloseTo(62 / 1235, 12)
  })

  it('varies the limits with the denominator', () => {
    const r = buildPChart({ points: periods(y, n), baseline: ALL(12), sigmaWidth: 3 })
    const p = 62 / 1235
    // n = 100 (index 0)
    expect(r.points[0].ucl!).toBeCloseTo(p + 3 * Math.sqrt((p * (1 - p)) / 100), 10)
    // n = 95 (index 2) — a smaller denominator must give a wider limit
    expect(r.points[2].ucl!).toBeCloseTo(p + 3 * Math.sqrt((p * (1 - p)) / 95), 10)
    expect(r.points[2].ucl!).toBeGreaterThan(r.points[0].ucl!)
  })

  it('clamps the lower limit to 0 and the upper to 1', () => {
    const r = buildPChart({ points: periods(y, n), baseline: ALL(12), sigmaWidth: 3 })
    for (const pt of r.points) {
      expect(pt.lcl).toBeGreaterThanOrEqual(0)
      expect(pt.ucl!).toBeLessThanOrEqual(1)
    }
  })

  it('plots the proportion, keeping numerator and denominator for the tooltip', () => {
    const r = buildPChart({ points: periods(y, n), baseline: ALL(12), sigmaWidth: 3 })
    expect(r.points[0].value).toBeCloseTo(5 / 100, 12)
    expect(r.points[0].numerator).toBe(5)
    expect(r.points[0].denominator).toBe(100)
  })

  it('warns when the data are overdispersed enough to want a prime chart', () => {
    // Wildly varying proportions on large denominators: binomial sigma is tiny,
    // so the z-scores scatter far more than 1.
    const over = buildPChart({
      points: periods([10, 90, 15, 85, 20, 80], [1000, 1000, 1000, 1000, 1000, 1000]),
      baseline: ALL(6),
      sigmaWidth: 3,
    })
    expect(over.warnings.some(w => w.code === 'overdispersion-prefer-prime')).toBe(true)
  })

  it('honours an imposed target instead of fitting the centre', () => {
    const r = buildPChart({ points: periods(y, n), baseline: ALL(12), sigmaWidth: 3, target: 0.1 })
    expect(r.centre).toBe(0.1)
  })
})

describe('Laney prime charts', () => {
  const y = [10, 90, 15, 85, 20, 80]
  const n = Array(6).fill(1000)

  it('widens the limits by sigma_z when overdispersed', () => {
    const plain = buildPChart({ points: periods(y, n), baseline: ALL(6), sigmaWidth: 3 })
    const prime = buildPChart({ points: periods(y, n), baseline: ALL(6), sigmaWidth: 3, prime: true })
    expect(prime.sigmaZ!).toBeGreaterThan(1)
    expect(prime.points[0].ucl!).toBeGreaterThan(plain.points[0].ucl!)
    // Same centre — only the dispersion changes.
    expect(prime.centre).toBeCloseTo(plain.centre, 12)
  })

  it('collapses to the plain chart when dispersion matches the model', () => {
    // sigma_z of a series whose scatter equals binomial expectation is ~1.
    const sz = laneySigmaZ(
      periods([50, 50, 50, 50], [1000, 1000, 1000, 1000]),
      0.05,
      (nn: number) => Math.sqrt((0.05 * 0.95) / nn),
    )
    expect(sz).toBe(1) // a constant series gives no moving range → falls back to 1
  })

  it('never returns a degenerate factor that would collapse the limits', () => {
    expect(laneySigmaZ(periods([1], [10]), 0.1, () => 0.1)).toBe(1)
    expect(laneySigmaZ(periods([1, 1], [10, 10]), 0.1, () => 0)).toBe(1)
  })
})

describe('buildUChart', () => {
  it('scales the rate and its sigma by the basis', () => {
    const pts = periods([3, 5, 2, 4], [900, 1100, 800, 1000])
    const r = buildUChart({ points: pts, baseline: ALL(4), sigmaWidth: 3, basis: 1000 })
    const centre = ((3 + 5 + 2 + 4) / (900 + 1100 + 800 + 1000)) * 1000
    expect(r.centre).toBeCloseTo(centre, 10)
    expect(r.points[0].value).toBeCloseTo((3 / 900) * 1000, 10)
    expect(r.points[0].ucl!).toBeCloseTo(centre + 3 * Math.sqrt((centre * 1000) / 900), 10)
  })

  it('floors the lower limit at 0 with no upper bound', () => {
    const r = buildUChart({
      points: periods([1, 0, 2, 1], [500, 500, 500, 500]),
      baseline: ALL(4),
      sigmaWidth: 3,
      basis: 1000,
    })
    for (const pt of r.points) expect(pt.lcl).toBe(0)
    expect(r.points[0].ucl!).toBeGreaterThan(r.centre)
  })
})

describe('buildCChart and buildNpChart', () => {
  it('c-chart: sigma is the square root of the mean count, constant', () => {
    const r = buildCChart({ points: periods([4, 6, 5, 3, 7], [1, 1, 1, 1, 1]), baseline: ALL(5), sigmaWidth: 3 })
    expect(r.centre).toBeCloseTo(5, 12)
    expect(r.points[0].ucl!).toBeCloseTo(5 + 3 * Math.sqrt(5), 10)
    // Constant limits: every point shares them.
    expect(r.points[1].ucl!).toBeCloseTo(r.points[0].ucl!, 12)
  })

  it('np-chart: centre is n-bar times p-bar', () => {
    const r = buildNpChart({ points: periods([5, 7, 6], [100, 100, 100]), baseline: ALL(3), sigmaWidth: 3 })
    expect(r.centre).toBeCloseTo(6, 10)
  })

  it('exposes D4 for the companion moving-range chart', () => {
    expect(D4_MR2).toBeCloseTo(3.267, 3)
  })
})

describe('buildIChart', () => {
  // mean 12.3, MRbar 2.0, sigma 2/1.128 = 1.7730496...
  const values = [10, 12, 11, 15, 13, 12, 14, 11, 13, 12]

  it('matches the hand-computed individuals limits', () => {
    const r = buildIChart({
      points: periods(values, Array(values.length).fill(1)),
      baseline: ALL(values.length),
      sigmaWidth: 3,
    })
    expect(r.centre).toBeCloseTo(12.3, 10)
    expect(r.points[0].ucl!).toBeCloseTo(12.3 + 3 * (2 / 1.128), 8)
    expect(r.points[0].lcl!).toBeCloseTo(12.3 - 3 * (2 / 1.128), 8)
  })

  it('leaves the limits unbounded — a measurement has no natural floor', () => {
    const r = buildIChart({
      points: periods([-5, -3, -4, -6], [1, 1, 1, 1]),
      baseline: ALL(4),
      sigmaWidth: 3,
    })
    expect(r.points[0].lcl!).toBeLessThan(0)
  })
})

describe('buildGChart', () => {
  // gaps mean 34.5 → sigma = sqrt(34.5 * 35.5) = 34.99642...
  const gaps = [12, 45, 30, 60, 22, 38]

  it('uses the geometric sigma sqrt(m(m+1))', () => {
    const r = buildGChart({ points: periods(gaps, Array(6).fill(1)), baseline: ALL(6), sigmaWidth: 3 })
    expect(r.centre).toBeCloseTo(34.5, 10)
    expect(r.points[0].ucl!).toBeCloseTo(34.5 + 3 * Math.sqrt(34.5 * 35.5), 8)
  })

  it('floors the lower limit at 0 — an interval cannot be negative', () => {
    const r = buildGChart({ points: periods(gaps, Array(6).fill(1)), baseline: ALL(6), sigmaWidth: 3 })
    expect(r.points[0].lcl).toBe(0)
  })
})

describe('buildTChart', () => {
  const intervals = [10, 25, 14, 40, 18, 30, 22]

  it('produces asymmetric limits on the original scale', () => {
    const r = buildTChart({ points: periods(intervals, Array(7).fill(1)), baseline: ALL(7), sigmaWidth: 3 })
    const up = r.points[0].ucl! - r.centre
    const down = r.centre - r.points[0].lcl!
    // The transform is what makes a waiting-time chart correct: the upper tail
    // is longer than the lower one, unlike a symmetric Shewhart chart.
    expect(up).toBeGreaterThan(down)
  })

  it('keeps the lower limit non-negative', () => {
    const r = buildTChart({ points: periods(intervals, Array(7).fill(1)), baseline: ALL(7), sigmaWidth: 3 })
    for (const pt of r.points) expect(pt.lcl!).toBeGreaterThanOrEqual(0)
  })
})

describe('buildEwmaChart', () => {
  const pts = periods([5, 3, 8, 4, 6, 2, 7, 5], Array(8).fill(100))

  it('follows the recursion z = lambda*y + (1-lambda)*z', () => {
    const r = buildEwmaChart({
      points: pts,
      baseline: ALL(8),
      sigmaWidth: 3,
      lambda: 0.2,
      valueOf: p => p.y / p.n,
      varianceOf: () => 0.0001,
    })
    const centre = pts.reduce((a, p) => a + p.y / p.n, 0) / 8
    const z1 = 0.2 * (5 / 100) + 0.8 * centre
    expect(r.points[0].value).toBeCloseTo(z1, 12)
    expect(r.points[1].value).toBeCloseTo(0.2 * (3 / 100) + 0.8 * z1, 12)
  })

  it('widens the early limits, because the exact variance has no history yet', () => {
    const r = buildEwmaChart({
      points: pts,
      baseline: ALL(8),
      sigmaWidth: 3,
      lambda: 0.2,
      valueOf: p => p.y / p.n,
      varianceOf: () => 0.0001,
    })
    const spread = (i: number) => r.points[i].ucl! - r.points[i].lcl!
    // The recursive variance grows towards its asymptote, so limits widen and
    // then settle — the first point must be the tightest, not the widest.
    expect(spread(0)).toBeLessThan(spread(1))
    expect(spread(1)).toBeLessThan(spread(7))
  })

  it('keeps the raw numerator and denominator for the tooltip', () => {
    const r = buildEwmaChart({
      points: pts,
      baseline: ALL(8),
      sigmaWidth: 3,
      lambda: 0.2,
      valueOf: p => p.y / p.n,
      varianceOf: () => 0.0001,
    })
    expect(r.points[0].numerator).toBe(5)
    expect(r.points[0].denominator).toBe(100)
  })

  it('respects the bounds of a proportion', () => {
    const r = buildEwmaChart({
      points: periods([95, 98, 97], [100, 100, 100]),
      baseline: ALL(3),
      sigmaWidth: 3,
      lambda: 0.5,
      valueOf: p => p.y / p.n,
      varianceOf: () => 0.01,
      bounds: { min: 0, max: 1 },
    })
    for (const pt of r.points) expect(pt.ucl!).toBeLessThanOrEqual(1)
  })
})

describe('Phase I / Phase II', () => {
  it('fits the limits on the baseline only, so a later drift still signals', () => {
    // Stable at ~5%, then jumps to ~30%. Limits fitted on the first six periods
    // must not absorb the jump.
    const y = [5, 4, 6, 5, 5, 4, 30, 32, 29, 31]
    const n = Array(10).fill(100)
    const frozen = buildPChart({ points: periods(y, n), baseline: { end: 6 }, sigmaWidth: 3 })
    const refitted = buildPChart({ points: periods(y, n), baseline: ALL(10), sigmaWidth: 3 })

    expect(frozen.centre).toBeCloseTo(29 / 600, 10)
    expect(frozen.points[6].value).toBeGreaterThan(frozen.points[6].ucl!)
    // Refitting on everything drags the centre up and widens the limits, which
    // is exactly how a chart hides the drift it should reveal.
    expect(refitted.centre).toBeGreaterThan(frozen.centre)
    expect(refitted.points[6].ucl!).toBeGreaterThan(frozen.points[6].ucl!)
  })

  it('marks which points belong to the baseline', () => {
    const r = buildPChart({
      points: periods([5, 4, 6, 5], [100, 100, 100, 100]),
      baseline: { end: 2 },
      sigmaWidth: 3,
    })
    expect(r.points.map(p => p.baseline)).toEqual([true, true, false, false])
    expect(r.baselineCount).toBe(2)
  })
})
