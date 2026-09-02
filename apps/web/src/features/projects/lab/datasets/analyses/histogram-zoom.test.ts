import { describe, it, expect } from 'vitest'
import { windowFromDrag, valuesInWindow, binCountForWindow, isZoomed } from './histogram-zoom'

// Ten bins of width 10 covering [0, 100).
const BOUNDS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
const UPPER = 100

describe('windowFromDrag', () => {
  it('maps selected bars to the value range they cover', () => {
    // Bins 2..4 span [20, 50): the top of bin 4 is bin 5's floor.
    expect(windowFromDrag(2, 4, BOUNDS, UPPER)).toEqual({ lo: 20, hi: 50 })
  })

  it('normalises a right-to-left drag', () => {
    expect(windowFromDrag(4, 2, BOUNDS, UPPER)).toEqual({ lo: 20, hi: 50 })
  })

  it('extends the last bin to the overall upper bound', () => {
    // Bin 9 has no successor to borrow a floor from.
    expect(windowFromDrag(7, 9, BOUNDS, UPPER)).toEqual({ lo: 70, hi: 100 })
  })

  it('ignores a click or a too-narrow drag', () => {
    expect(windowFromDrag(5, 5, BOUNDS, UPPER)).toBeNull()
    expect(windowFromDrag(5, 6, BOUNDS, UPPER)).toBeNull()
    // Three bars is the narrowest deliberate selection.
    expect(windowFromDrag(5, 7, BOUNDS, UPPER)).toEqual({ lo: 50, hi: 80 })
  })

  it('clamps indices that fall outside the bins', () => {
    expect(windowFromDrag(-3, 2, BOUNDS, UPPER)).toEqual({ lo: 0, hi: 30 })
    expect(windowFromDrag(7, 99, BOUNDS, UPPER)).toEqual({ lo: 70, hi: 100 })
  })

  it('returns null with a missing bound or no bins', () => {
    expect(windowFromDrag(null, 3, BOUNDS, UPPER)).toBeNull()
    expect(windowFromDrag(1, undefined, BOUNDS, UPPER)).toBeNull()
    expect(windowFromDrag(1, 5, [], UPPER)).toBeNull()
  })

  it('returns null when the range would be empty', () => {
    // Degenerate bounds (a single-value column) can't be zoomed into.
    expect(windowFromDrag(0, 2, [5, 5, 5], 5)).toBeNull()
  })
})

describe('valuesInWindow', () => {
  const values = [1, 5, 10, 15, 20, 25, 30]

  it('returns everything when unzoomed', () => {
    expect(valuesInWindow(values, null)).toEqual(values)
  })

  it('keeps both bounds', () => {
    expect(valuesInWindow(values, { lo: 10, hi: 20 })).toEqual([10, 15, 20])
  })

  it('can select nothing', () => {
    expect(valuesInWindow(values, { lo: 100, hi: 200 })).toEqual([])
  })
})

describe('binCountForWindow', () => {
  it('honours the configured count when the data supports it', () => {
    const values = Array.from({ length: 100 }, (_, i) => i * 0.5)
    expect(binCountForWindow(values, 20)).toBe(20)
  })

  it('caps at the number of distinct values', () => {
    // Ages 1..10 with 20 bins asked for would leave every other bar empty.
    const ages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 5, 5]
    expect(binCountForWindow(ages, 20)).toBe(10)
  })

  it('never returns zero', () => {
    expect(binCountForWindow([7, 7, 7], 20)).toBe(1)
    expect(binCountForWindow([], 20)).toBe(20)
  })
})

describe('isZoomed', () => {
  it('is true exactly when a window is set', () => {
    expect(isZoomed(null)).toBe(false)
    expect(isZoomed({ lo: 1, hi: 2 })).toBe(true)
  })
})
