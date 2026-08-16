import { describe, it, expect } from 'vitest'
import { niceStep, niceTicks, tightHistogramScale } from './chart-ticks'

describe('niceStep', () => {
  it('rounds up to 1/2/5 × 10ⁿ', () => {
    expect(niceStep(0.8)).toBe(1)
    expect(niceStep(1.5)).toBe(2)
    expect(niceStep(3)).toBe(5)
    expect(niceStep(7)).toBe(10)
    expect(niceStep(45)).toBe(50)
    expect(niceStep(120)).toBe(200)
  })

  it('falls back to 1 for non-positive or non-finite input', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-3)).toBe(1)
    expect(niceStep(Infinity)).toBe(1)
    expect(niceStep(NaN)).toBe(1)
  })
})

describe('niceTicks', () => {
  it('produces round ticks spanning the data range', () => {
    const result = niceTicks([-27, 14, 801])
    expect(result).not.toBeNull()
    // All ticks are whole numbers (no float dust like 199.99999).
    expect(result!.ticks.every((t) => Number.isInteger(t))).toBe(true)
    // Domain brackets the data.
    expect(result!.domain[0]).toBeLessThanOrEqual(-27)
    expect(result!.domain[1]).toBeGreaterThanOrEqual(801)
  })

  it('clamps the low bound to zero when startAtZero is set', () => {
    const result = niceTicks([12, 480], true)
    expect(result!.domain[0]).toBe(0)
    expect(result!.ticks[0]).toBe(0)
  })

  it('avoids float drift on fractional steps', () => {
    const result = niceTicks([0, 0.6])
    expect(result).not.toBeNull()
    for (const t of result!.ticks) {
      expect(t).toBeCloseTo(Number(t.toFixed(4)), 10)
    }
  })

  it('handles a degenerate single-value range', () => {
    const result = niceTicks([5, 5])
    expect(result).not.toBeNull()
    expect(result!.domain[0]).toBeLessThan(5)
    expect(result!.domain[1]).toBeGreaterThan(5)
  })

  it('returns null for empty or all-non-finite input', () => {
    expect(niceTicks([])).toBeNull()
    expect(niceTicks([NaN, Infinity])).toBeNull()
  })
})

describe('tightHistogramScale', () => {
  it('tracks the data min rather than flooring the domain to zero', () => {
    // Many narrow bins — the half-bin padding stays small, so the domain hugs
    // the real minimum instead of starting at 0 the way niceTicks would.
    const xs = Array.from({ length: 20 }, (_, i) => 467 + i * 70)
    const result = tightHistogramScale(xs)!
    expect(result.domain[0]).toBeGreaterThan(0)
    expect(result.domain[0]).toBeLessThanOrEqual(467)
  })

  it('brackets the full data range', () => {
    const xs = [10, 20, 30, 40]
    const result = tightHistogramScale(xs)!
    expect(result.domain[0]).toBeLessThanOrEqual(Math.min(...xs))
    expect(result.domain[1]).toBeGreaterThanOrEqual(Math.max(...xs))
  })

  it('lays every tick inside the domain', () => {
    const result = tightHistogramScale([50, 71, 92, 113, 136])!
    for (const tick of result.ticks) {
      expect(tick).toBeGreaterThanOrEqual(result.domain[0])
      expect(tick).toBeLessThanOrEqual(result.domain[1])
    }
  })

  it('falls back to niceTicks on a degenerate single-value range', () => {
    const result = tightHistogramScale([5, 5])
    expect(result).not.toBeNull()
    expect(result!.domain[0]).toBeLessThan(5)
    expect(result!.domain[1]).toBeGreaterThan(5)
  })

  it('returns null for empty or all-non-finite input', () => {
    expect(tightHistogramScale([])).toBeNull()
    expect(tightHistogramScale([NaN, Infinity])).toBeNull()
  })
})
