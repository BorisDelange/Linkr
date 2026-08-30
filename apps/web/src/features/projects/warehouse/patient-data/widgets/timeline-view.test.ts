import { describe, it, expect } from 'vitest'
import {
  clampWindow,
  zoomWindow,
  panWindow,
  windowFromRangeDrag,
  isFullWindow,
  axisTicks,
  MIN_SPAN_MS,
} from './timeline-view'

// Zoom and pan are the part of a chart people notice immediately when it is
// wrong: a window that squashes at the edges, a wheel zoom that walks away from
// the cursor, a click that blanks the plot.

const BOUNDS = { lo: 0, hi: 100_000 }

describe('clampWindow', () => {
  it('leaves a window that already fits', () => {
    expect(clampWindow({ lo: 10_000, hi: 20_000 }, BOUNDS)).toEqual({ lo: 10_000, hi: 20_000 })
  })

  it('slides a window back inside rather than squashing it', () => {
    // Keeping the span is what makes a pan stop against the edge instead of
    // shrinking the view as it goes.
    const r = clampWindow({ lo: -5_000, hi: 5_000 }, BOUNDS)
    expect(r).toEqual({ lo: 0, hi: 10_000 })
  })

  it('stops against the right edge with its width intact', () => {
    expect(clampWindow({ lo: 95_000, hi: 105_000 }, BOUNDS)).toEqual({ lo: 90_000, hi: 100_000 })
  })

  it('never exceeds the full bounds', () => {
    expect(clampWindow({ lo: -50_000, hi: 200_000 }, BOUNDS)).toEqual(BOUNDS)
  })

  it('refuses to go below the minimum span', () => {
    const r = clampWindow({ lo: 500, hi: 501 }, BOUNDS)
    expect(r.hi - r.lo).toBe(MIN_SPAN_MS)
  })
})

describe('zoomWindow', () => {
  it('keeps the timestamp under the cursor in place', () => {
    const view = { lo: 0, hi: 100_000 }
    // Focus at 25% → t = 25_000. After zooming in it must still sit at 25%.
    const next = zoomWindow(view, BOUNDS, 0.5, 0.25)
    const focusAfter = next.lo + (next.hi - next.lo) * 0.25
    expect(Math.round(focusAfter)).toBe(25_000)
  })

  it('halves the span when zooming in', () => {
    const next = zoomWindow({ lo: 0, hi: 40_000 }, BOUNDS, 0.5, 0.5)
    expect(next.hi - next.lo).toBe(20_000)
  })

  it('cannot zoom out past the record', () => {
    const next = zoomWindow({ lo: 40_000, hi: 60_000 }, BOUNDS, 10, 0.5)
    expect(next).toEqual(BOUNDS)
  })

  it('cannot zoom in below the minimum span', () => {
    const next = zoomWindow({ lo: 0, hi: 2_000 }, BOUNDS, 0.01, 0.5)
    expect(next.hi - next.lo).toBe(MIN_SPAN_MS)
  })

  it('clamps a focal point outside the plot instead of drifting', () => {
    const next = zoomWindow({ lo: 0, hi: 40_000 }, BOUNDS, 0.5, 5)
    expect(next.lo).toBeGreaterThanOrEqual(BOUNDS.lo)
    expect(next.hi).toBeLessThanOrEqual(BOUNDS.hi)
  })
})

describe('panWindow', () => {
  it('drags the window back in time when pulled right', () => {
    // 100px of 200px wide, over a 20s window → 10s back.
    const next = panWindow({ lo: 40_000, hi: 60_000 }, BOUNDS, 100, 200)
    expect(next).toEqual({ lo: 30_000, hi: 50_000 })
  })

  it('drags forward when pulled left', () => {
    const next = panWindow({ lo: 40_000, hi: 60_000 }, BOUNDS, -100, 200)
    expect(next).toEqual({ lo: 50_000, hi: 70_000 })
  })

  it('stops at the edge keeping the span', () => {
    const next = panWindow({ lo: 0, hi: 20_000 }, BOUNDS, 500, 200)
    expect(next).toEqual({ lo: 0, hi: 20_000 })
  })

  it('ignores a pan before the plot has been measured', () => {
    const view = { lo: 0, hi: 20_000 }
    expect(panWindow(view, BOUNDS, 50, 0)).toBe(view)
  })
})

describe('windowFromRangeDrag', () => {
  it('selects the dragged span', () => {
    // Strip from x=0 to x=200 covering the full record.
    expect(windowFromRangeDrag(50, 100, 0, 200, BOUNDS)).toEqual({ lo: 25_000, hi: 50_000 })
  })

  it('works when dragged right to left', () => {
    expect(windowFromRangeDrag(100, 50, 0, 200, BOUNDS)).toEqual({ lo: 25_000, hi: 50_000 })
  })

  it('ignores a click, which would zoom to nothing', () => {
    expect(windowFromRangeDrag(100, 101, 0, 200, BOUNDS)).toBeNull()
  })

  it('clamps a drag that runs off the strip', () => {
    const r = windowFromRangeDrag(-50, 250, 0, 200, BOUNDS)!
    expect(r.lo).toBeGreaterThanOrEqual(BOUNDS.lo)
    expect(r.hi).toBeLessThanOrEqual(BOUNDS.hi)
  })
})

describe('isFullWindow', () => {
  it('recognises the whole record', () => {
    expect(isFullWindow(BOUNDS, BOUNDS)).toBe(true)
  })

  it('recognises a zoomed window', () => {
    expect(isFullWindow({ lo: 10, hi: 90_000 }, BOUNDS)).toBe(false)
  })
})

describe('axisTicks', () => {
  it('lands ticks on round values, not on the window edge', () => {
    // A window starting mid-minute must still tick on the minute.
    const ticks = axisTicks({ lo: 1_000, hi: 601_000 }, 6)
    expect(ticks.every((t) => t % 1000 === 0)).toBe(true)
  })

  it('stays inside the window', () => {
    const view = { lo: 1_000, hi: 601_000 }
    for (const t of axisTicks(view, 6)) {
      expect(t).toBeGreaterThanOrEqual(view.lo)
      expect(t).toBeLessThanOrEqual(view.hi)
    }
  })

  it('produces roughly the requested number of ticks', () => {
    const ticks = axisTicks({ lo: 0, hi: 86_400_000 }, 6)
    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks.length).toBeLessThanOrEqual(12)
  })

  it('returns nothing for a degenerate window rather than looping forever', () => {
    expect(axisTicks({ lo: 5, hi: 5 }, 6)).toEqual([])
    expect(axisTicks({ lo: 10, hi: 0 }, 6)).toEqual([])
  })
})
