import { describe, it, expect } from 'vitest'
import { windowFromDrag, composeZoom, sliceToWindow, isZoomed } from './histogram-zoom'

describe('windowFromDrag', () => {
  it('normalises a right-to-left drag', () => {
    expect(windowFromDrag(8, 2, 20)).toEqual({ start: 2, end: 8 })
  })

  it('ignores a click or a too-narrow drag', () => {
    // Otherwise reading the chart with the mouse down would collapse it to a bar.
    expect(windowFromDrag(5, 5, 20)).toBeNull()
    expect(windowFromDrag(5, 6, 20)).toBeNull()
    // Three bins is the narrowest deliberate selection.
    expect(windowFromDrag(5, 7, 20)).toEqual({ start: 5, end: 7 })
  })

  it('clamps to the data instead of running off either end', () => {
    expect(windowFromDrag(-4, 3, 20)).toEqual({ start: 0, end: 3 })
    expect(windowFromDrag(15, 99, 20)).toEqual({ start: 15, end: 19 })
  })

  it('returns null when a bound is missing or there is no data', () => {
    expect(windowFromDrag(null, 3, 20)).toBeNull()
    expect(windowFromDrag(1, undefined, 20)).toBeNull()
    expect(windowFromDrag(1, 5, 0)).toBeNull()
  })
})

describe('composeZoom', () => {
  it('is the drag itself when nothing is zoomed yet', () => {
    expect(composeZoom(null, { start: 2, end: 5 })).toEqual({ start: 2, end: 5 })
  })

  it('maps a second drag back onto the full dataset', () => {
    // Zoomed to bins 10..19, then dragging the on-screen bins 1..4 must land on
    // 11..14 of the original data — not back near the start.
    expect(composeZoom({ start: 10, end: 19 }, { start: 1, end: 4 }))
      .toEqual({ start: 11, end: 14 })
  })

  it('composes repeatedly without drifting', () => {
    let w = composeZoom(null, { start: 5, end: 15 })
    w = composeZoom(w, { start: 2, end: 6 })
    w = composeZoom(w, { start: 1, end: 3 })
    expect(w).toEqual({ start: 8, end: 10 })
  })
})

describe('sliceToWindow', () => {
  const data = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

  it('returns everything when unzoomed', () => {
    expect(sliceToWindow(data, null)).toEqual(data)
  })

  it('includes both bounds', () => {
    expect(sliceToWindow(data, { start: 2, end: 4 })).toEqual([2, 3, 4])
  })
})

describe('isZoomed', () => {
  it('is false for no window, or one covering everything', () => {
    expect(isZoomed(null, 10)).toBe(false)
    expect(isZoomed({ start: 0, end: 9 }, 10)).toBe(false)
  })

  it('is true as soon as either end hides a bin', () => {
    expect(isZoomed({ start: 1, end: 9 }, 10)).toBe(true)
    expect(isZoomed({ start: 0, end: 8 }, 10)).toBe(true)
  })
})
