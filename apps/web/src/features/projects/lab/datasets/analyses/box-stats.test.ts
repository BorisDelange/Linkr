import { describe, it, expect } from 'vitest'
import { computeBoxStats } from './KeyIndicatorComponent'

/**
 * These values are pinned against the server mirror, `_linkr_boxplot_stats` in
 * apps/api/app/services/execution/render/key_indicator.py — the same column must
 * draw the same box whether the widget renders on the client or on the server.
 */
describe('computeBoxStats', () => {
  it('pulls the whiskers back to 1.5x IQR instead of the raw extremes', () => {
    const s = computeBoxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 500])!
    expect([s.q1, s.median, s.q3]).toEqual([3, 6, 9])
    // q3 + 1.5*iqr = 9 + 9 = 18, so the 500 sits outside the whisker.
    expect(s.max).toBe(18)
    expect(s.min).toBe(1)
  })

  it('keeps a whisker at the real extreme when nothing is further out', () => {
    const s = computeBoxStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])!
    expect(s.min).toBe(10)
    expect(s.max).toBe(100)
  })

  it('collapses to a point for a constant column', () => {
    const s = computeBoxStats([5, 5, 5, 5])!
    expect([s.min, s.q1, s.median, s.q3, s.max]).toEqual([5, 5, 5, 5, 5])
    expect(s.mean).toBe(5)
  })

  it('handles a single value', () => {
    const s = computeBoxStats([3])!
    expect([s.min, s.median, s.max, s.mean]).toEqual([3, 3, 3, 3])
  })

  it('returns null with no usable numbers, so the chart renders nothing', () => {
    expect(computeBoxStats([])).toBeNull()
    expect(computeBoxStats([NaN, Infinity])).toBeNull()
  })

  it('reports the mean over every value, outliers included', () => {
    // The whiskers clip the drawing, not the statistic.
    const s = computeBoxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 500])!
    expect(s.mean).toBeCloseTo(50.4545, 3)
  })
})
