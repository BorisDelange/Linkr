import { describe, it, expect } from 'vitest'
import { shapiroWilk, groupsLookNormal, NORMALITY_MIN_N } from './normality'

/**
 * Reference values come from R's `shapiro.test`, which implements the same
 * Royston (1992) algorithm. Tolerances are loose enough to absorb the different
 * normal-quantile approximation but tight enough to catch a wrong coefficient.
 */
describe('shapiroWilk', () => {
  it('matches R on a textbook normal sample', () => {
    // R: shapiro.test(c(148,154,158,160,161,162,166,170,182,195,236))
    //    W = 0.79, p-value = 0.008
    const x = [148, 154, 158, 160, 161, 162, 166, 170, 182, 195, 236]
    const r = shapiroWilk(x)!
    expect(r.n).toBe(11)
    expect(r.w).toBeCloseTo(0.79, 1)
    // Pinned to R's VALUE, not merely to the right side of 0.05: asserting only
    // `< 0.05` let a branch that returned a constant 0 pass for every input.
    expect(r.pValue).toBeCloseTo(0.0076, 2)
  })

  /**
   * The `n <= 11` branch takes a different Royston transform from the one above
   * 11, so it needs its own reference values — it once fed W where the transform
   * expects `log(1 - W)`, which pinned p to 0 across this entire window while the
   * n > 11 tests stayed green.
   */
  it.each([
    // R: shapiro.test(...) on each sample.
    { label: 'n=8 normal', x: [-1.4, -0.8, -0.3, 0, 0, 0.3, 0.8, 1.4], p: 0.99, digits: 1 },
    { label: 'n=9 evenly spaced', x: [10, 11, 12, 13, 14, 15, 16, 17, 18], p: 0.91, digits: 1 },
    { label: 'n=10 normal', x: [-1.5, -1, -0.6, -0.3, 0, 0, 0.3, 0.6, 1, 1.5], p: 0.999, digits: 2 },
  ])('does not reject a normal sample of $label', ({ x, p, digits }) => {
    const r = shapiroWilk(x)!
    expect(r.pValue).toBeCloseTo(p, digits)
    expect(r.pValue).toBeGreaterThan(0.05)
  })

  it('still rejects a skewed sample in the small-n branch', () => {
    // n=8, one extreme value: R gives p ≈ 1.2e-4.
    const r = shapiroWilk([1, 1, 1, 1, 1, 1, 2, 90])!
    expect(r.pValue).toBeLessThan(0.01)
  })

  it('gives a perfectly linear sample a p-value near 1, not 0', () => {
    // W is exactly 1 here, so `log(1 - W)` is -Infinity: the guard must read that
    // as the most normal sample possible, never as the degenerate end.
    const r = shapiroWilk([1, 2, 3, 4, 5, 6, 7, 8, 9])!
    expect(r.pValue).toBeGreaterThan(0.5)
  })

  it('does not reject a clean normal sample', () => {
    // Symmetric, evenly spaced: about as normal as a small sample gets.
    const x = [-3, -2, -2, -1, -1, -1, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3]
    const r = shapiroWilk(x)!
    expect(r.pValue).toBeGreaterThan(0.05)
    expect(r.w).toBeGreaterThan(0.9)
  })

  it('rejects a strongly skewed sample', () => {
    // One extreme value dragging a tight cluster: the shape a length-of-stay
    // column actually has, and precisely when a t-test is the wrong choice.
    const x = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6, 90]
    const r = shapiroWilk(x)!
    expect(r.pValue).toBeLessThan(0.01)
  })

  it('returns a W in (0, 1]', () => {
    for (const x of [[1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 1, 2, 50]]) {
      const r = shapiroWilk(x)
      if (!r) continue
      expect(r.w).toBeGreaterThan(0)
      expect(r.w).toBeLessThanOrEqual(1)
      expect(r.pValue).toBeGreaterThanOrEqual(0)
      expect(r.pValue).toBeLessThanOrEqual(1)
    }
  })

  it('abstains rather than guessing on degenerate input', () => {
    expect(shapiroWilk([])).toBeNull()
    expect(shapiroWilk([1, 2])).toBeNull()
    // A constant column is not "non-normal", it is degenerate.
    expect(shapiroWilk([5, 5, 5, 5, 5])).toBeNull()
  })

  it('ignores non-finite values instead of returning NaN', () => {
    const r = shapiroWilk([1, 2, 3, 4, 5, NaN, Infinity])!
    expect(r.n).toBe(5)
    expect(Number.isFinite(r.w)).toBe(true)
    expect(Number.isFinite(r.pValue)).toBe(true)
  })
})

describe('groupsLookNormal', () => {
  const normal = Array.from({ length: 30 }, (_, i) => i - 15 + (i % 3) * 0.1)
  const skewed = [...Array.from({ length: 29 }, () => 1), 500]

  it('needs every group to pass, not just one', () => {
    expect(groupsLookNormal([normal, normal]).normal).toBe(true)
    // One skewed group is enough to make the comparison suspect.
    expect(groupsLookNormal([normal, skewed]).normal).toBe(false)
  })

  it('abstains on small groups instead of waving them through', () => {
    // Under the power threshold Shapiro-Wilk rejects almost nothing, so a pass
    // would be meaningless — the safer test wins by default.
    const tiny = Array.from({ length: NORMALITY_MIN_N - 1 }, (_, i) => i)
    const v = groupsLookNormal([tiny, tiny])
    expect(v.reason).toBe('not-tested-small')
    expect(v.normal).toBe(false)
  })

  it('does not punish a large sample for a trivial deviation', () => {
    // Past the cap the test rejects on deviations too small to matter, and the
    // CLT has made the mean normal anyway.
    const huge = Array.from({ length: 5001 }, (_, i) => (i % 7) + i * 1e-6)
    const v = groupsLookNormal([huge, huge])
    expect(v.reason).toBe('not-tested-large')
    expect(v.normal).toBe(true)
  })

  it('reports the worst p across the groups, for the tooltip', () => {
    const v = groupsLookNormal([normal, normal])
    expect(v.reason).toBe('tested')
    expect(v.pValue).toBeGreaterThan(0.05)
  })
})
