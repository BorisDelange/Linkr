import { describe, it, expect } from 'vitest'
import {
  clampWindow,
  zoomWindow,
  windowFromPlotDrag,
  hitRange,
  windowFromRangeGrab,
  windowFromRangeJump,
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

describe('windowFromPlotDrag', () => {
  // The plot, x=0..200, showing the whole record.
  const FULL = { lo: 0, hi: 100_000 }

  it('selects the dragged span', () => {
    expect(windowFromPlotDrag(50, 100, 0, 200, FULL, BOUNDS)).toEqual({ lo: 25_000, hi: 50_000 })
  })

  it('works when dragged right to left', () => {
    expect(windowFromPlotDrag(100, 50, 0, 200, FULL, BOUNDS)).toEqual({ lo: 25_000, hi: 50_000 })
  })

  it('reads against the current window, so zooming in twice keeps working', () => {
    // Already zoomed to 40s..60s: the same pixels now mean a much shorter span.
    const zoomed = { lo: 40_000, hi: 60_000 }
    expect(windowFromPlotDrag(50, 100, 0, 200, zoomed, BOUNDS)).toEqual({ lo: 45_000, hi: 50_000 })
  })

  it('ignores a click, which would zoom to nothing', () => {
    expect(windowFromPlotDrag(100, 101, 0, 200, FULL, BOUNDS)).toBeNull()
  })

  it('clamps a drag that runs off the plot', () => {
    const r = windowFromPlotDrag(-50, 250, 0, 200, FULL, BOUNDS)!
    expect(r.lo).toBeGreaterThanOrEqual(BOUNDS.lo)
    expect(r.hi).toBeLessThanOrEqual(BOUNDS.hi)
  })

  it('ignores a drag before the plot has been measured', () => {
    expect(windowFromPlotDrag(50, 100, 0, 0, FULL, BOUNDS)).toBeNull()
  })
})

// The range strip: x=0..200 covering the whole record, window over its middle
// half (x=50..150 → 25s..75s).
const GEOM = { x0: 0, x1: 200, y0: 100, y1: 120, win: { x0: 50, x1: 150 } }
const WIN = { lo: 25_000, hi: 75_000 }

describe('hitRange', () => {
  it('names each part of the strip', () => {
    expect(hitRange(GEOM, 50, 110)).toBe('lo')
    expect(hitRange(GEOM, 150, 110)).toBe('hi')
    expect(hitRange(GEOM, 100, 110)).toBe('move')
    expect(hitRange(GEOM, 180, 110)).toBe('jump')
  })

  it('gives the edges a grab zone wider than the drawn handle', () => {
    // The handle is 3px; aiming 4px off must still catch it, or resizing means
    // pixel-hunting.
    expect(hitRange(GEOM, 54, 110)).toBe('lo')
    expect(hitRange(GEOM, 146, 110)).toBe('hi')
  })

  it('prefers an edge over the body where the two overlap', () => {
    // Inside the window but within the edge zone: resizing wins, since dragging
    // the body from its very edge is never what was meant.
    expect(hitRange(GEOM, 52, 110)).toBe('lo')
  })

  it('ignores a pointer above or below the strip', () => {
    expect(hitRange(GEOM, 100, 40)).toBeNull()
    expect(hitRange(GEOM, 100, 200)).toBeNull()
  })

  it('still catches a window sitting flush against the strip edge', () => {
    const flush = { ...GEOM, win: { x0: 0, x1: 100 } }
    expect(hitRange(flush, -3, 110)).toBe('lo')
  })

  it('reports nothing before the strip has been painted', () => {
    expect(hitRange(null, 100, 110)).toBeNull()
  })
})

describe('windowFromRangeGrab', () => {
  it('moves the window without changing its span', () => {
    // Grabbed at its centre (50px in), dragged to x=125 → centred on 62.5s.
    const r = windowFromRangeGrab('move', GEOM, 125, 50, WIN, BOUNDS)
    expect(r.hi - r.lo).toBe(WIN.hi - WIN.lo)
    expect(r).toEqual({ lo: 37_500, hi: 87_500 })
  })

  it('keeps the span when a moved window hits the edge, rather than squashing it', () => {
    const r = windowFromRangeGrab('move', GEOM, 400, 50, WIN, BOUNDS)
    expect(r.hi - r.lo).toBe(WIN.hi - WIN.lo)
    expect(r.hi).toBe(BOUNDS.hi)
  })

  it('resizes one edge and leaves the other fixed', () => {
    expect(windowFromRangeGrab('lo', GEOM, 20, 0, WIN, BOUNDS)).toEqual({ lo: 10_000, hi: 75_000 })
    expect(windowFromRangeGrab('hi', GEOM, 180, 0, WIN, BOUNDS)).toEqual({ lo: 25_000, hi: 90_000 })
  })

  it('will not drag an edge past the other one', () => {
    // Dragging `lo` beyond `hi` would invert the window and blank the chart.
    const r = windowFromRangeGrab('lo', GEOM, 190, 0, WIN, BOUNDS)
    expect(r.lo).toBeLessThan(r.hi)
    expect(r.hi - r.lo).toBeGreaterThanOrEqual(MIN_SPAN_MS)
  })

  it('clamps a resize dragged off the strip', () => {
    const r = windowFromRangeGrab('lo', GEOM, -80, 0, WIN, BOUNDS)
    expect(r.lo).toBe(BOUNDS.lo)
  })
})

describe('windowFromRangeJump', () => {
  it('recentres the window on the click, keeping its span', () => {
    // x=120 → 60s, far enough from either bound that no clamping applies.
    const r = windowFromRangeJump(GEOM, 120, WIN, BOUNDS)
    expect(r.hi - r.lo).toBe(WIN.hi - WIN.lo)
    expect((r.lo + r.hi) / 2).toBe(60_000)
  })

  it('stops at the bounds instead of running past them', () => {
    const r = windowFromRangeJump(GEOM, 0, WIN, BOUNDS)
    expect(r.lo).toBe(BOUNDS.lo)
    expect(r.hi - r.lo).toBe(WIN.hi - WIN.lo)
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
