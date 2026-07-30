import { describe, it, expect } from 'vitest'
import { percentile, computeNumericStats, buildHistogram } from './column-stats'

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0)
  })

  it('returns the value itself for a single element', () => {
    expect(percentile([42], 25)).toBe(42)
    expect(percentile([42], 75)).toBe(42)
  })

  it('interpolates between neighbours', () => {
    // idx for p50 over 4 values = 1.5 → midpoint of 2 and 3
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
  })

  it('returns min at p0 and max at p100', () => {
    const sorted = [1, 5, 9, 20]
    expect(percentile(sorted, 0)).toBe(1)
    expect(percentile(sorted, 100)).toBe(20)
  })
})

describe('computeNumericStats', () => {
  it('computes the classic five-number summary + mean/std', () => {
    const s = computeNumericStats([4, 1, 3, 2, 5])
    expect(s.min).toBe(1)
    expect(s.max).toBe(5)
    expect(s.median).toBe(3)
    expect(s.q1).toBe(2)
    expect(s.q3).toBe(4)
    expect(s.iqr).toBe(2)
    expect(s.mean).toBe(3)
    expect(s.n).toBe(5)
    expect(s.std).toBeCloseTo(Math.sqrt(2), 10)
  })

  it('does not mutate the input array', () => {
    const values = [3, 1, 2]
    computeNumericStats(values)
    expect(values).toEqual([3, 1, 2])
  })

  it('returns zeroed stats (no NaN) for an empty array', () => {
    const s = computeNumericStats([])
    expect(s.n).toBe(0)
    expect(s.mean).toBe(0)
    expect(s.min).toBe(0)
    expect(Number.isNaN(s.std)).toBe(false)
  })
})

describe('buildHistogram', () => {
  it('returns [] for empty input', () => {
    expect(buildHistogram([], 10)).toEqual([])
  })

  it('returns a single 100% bin when all values are equal', () => {
    expect(buildHistogram([7, 7, 7], 10)).toEqual([{ x: 7, label: '7', count: 3, pct: 100 }])
  })

  it('covers every value exactly once (counts sum to n, pct to 100)', () => {
    const sorted = Array.from({ length: 50 }, (_, i) => i)
    const bins = buildHistogram(sorted, 15)
    const total = bins.reduce((a, b) => a + b.count, 0)
    expect(total).toBe(50)
    expect(bins.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(100, 6)
  })

  it('includes the max value in the last bin (closed upper bound)', () => {
    const bins = buildHistogram([0, 1, 2, 3, 10], 5)
    const total = bins.reduce((a, b) => a + b.count, 0)
    expect(total).toBe(5)
    expect(bins[bins.length - 1].count).toBeGreaterThanOrEqual(1)
  })

  it('bins are ordered by their numeric low bound', () => {
    const bins = buildHistogram([1, 2, 5, 8, 13, 21], 4)
    const xs = bins.map((b) => b.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })

  it('returns [] instead of looping forever on a non-finite bound', () => {
    expect(buildHistogram([0, 1, Infinity], 10)).toEqual([])
    expect(buildHistogram([-Infinity, 0, 1], 10)).toEqual([])
  })
})
