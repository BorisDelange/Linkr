import { describe, it, expect } from 'vitest'
import { outlierBounds, isWithinBounds, OUTLIER_DEFAULT_COEF } from './outliers'

// 1..10 plus a far outlier: q1 = 3.25, q3 = 8.5 over the 11 sorted values.
const WITH_OUTLIER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000]

describe('outlierBounds', () => {
  it('returns null for method none, so nothing is excluded', () => {
    expect(outlierBounds(WITH_OUTLIER, 'none', 1.5)).toBeNull()
  })

  it('iqr uses Tukey fences and rejects the extreme value', () => {
    const b = outlierBounds(WITH_OUTLIER, 'iqr', 1.5)!
    expect(b).not.toBeNull()
    expect(isWithinBounds(1000, b)).toBe(false)
    expect(isWithinBounds(10, b)).toBe(true)
    expect(isWithinBounds(1, b)).toBe(true)
  })

  it('a larger iqr coefficient keeps more values', () => {
    const tight = outlierBounds([1, 2, 3, 4, 100], 'iqr', 1.5)!
    const loose = outlierBounds([1, 2, 3, 4, 100], 'iqr', 50)!
    expect(isWithinBounds(100, tight)).toBe(false)
    expect(isWithinBounds(100, loose)).toBe(true)
  })

  it('sd centres on the mean and rejects beyond k standard deviations', () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 40]
    const b = outlierBounds(values, 'sd', 2)!
    expect(isWithinBounds(40, b)).toBe(false)
    expect(isWithinBounds(10, b)).toBe(true)
  })

  it('percentile cuts the requested tail from each side', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    const b = outlierBounds(values, 'percentile', 10)!
    // The 10th percentile of 1..100 is ~10.9, the 90th ~90.1.
    expect(isWithinBounds(1, b)).toBe(false)
    expect(isWithinBounds(100, b)).toBe(false)
    expect(isWithinBounds(50, b)).toBe(true)
  })

  it('a flat column excludes nothing rather than everything', () => {
    // Zero spread: IQR and SD are both 0, so naive fences would reject every value
    // that is not exactly the centre — including, for percentile, the whole column.
    const flat = [7, 7, 7, 7, 7]
    expect(outlierBounds(flat, 'iqr', 1.5)).toBeNull()
    expect(outlierBounds(flat, 'sd', 3)).toBeNull()
  })

  it('handles an empty column and ignores non-finite values', () => {
    expect(outlierBounds([], 'iqr', 1.5)).toBeNull()
    expect(outlierBounds([NaN, Infinity], 'iqr', 1.5)).toBeNull()
  })

  it('clamps a percentile coefficient into a usable range', () => {
    // 0 would exclude nothing; over 50 the two tails would cross.
    expect(outlierBounds([1, 2, 3], 'percentile', 0)).toBeNull()
    const b = outlierBounds([1, 2, 3, 4, 5], 'percentile', 90)!
    expect(b.lo).toBeLessThanOrEqual(b.hi)
  })
})

describe('isWithinBounds', () => {
  it('passes everything when there are no bounds', () => {
    expect(isWithinBounds(1e9, null)).toBe(true)
  })

  it('is inclusive at both edges', () => {
    const b = { lo: 0, hi: 10 }
    expect(isWithinBounds(0, b)).toBe(true)
    expect(isWithinBounds(10, b)).toBe(true)
    expect(isWithinBounds(-0.001, b)).toBe(false)
  })
})

describe('OUTLIER_DEFAULT_COEF', () => {
  it('pins the conventional defaults each method expects', () => {
    expect(OUTLIER_DEFAULT_COEF.iqr).toBe(1.5)
    expect(OUTLIER_DEFAULT_COEF.sd).toBe(3)
    expect(OUTLIER_DEFAULT_COEF.percentile).toBe(1)
  })
})
