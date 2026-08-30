import { describe, it, expect } from 'vitest'
import { eventShape, shade, type OverviewEvent } from './event-marks'

// The shape rule is what makes the timeline able to draw a record rather than
// just a curve, and it is shared with the overview — a change here moves both.

const ev = (over: Partial<OverviewEvent>): OverviewEvent => ({
  start: 0,
  end: null,
  value: null,
  text: null,
  conceptId: null,
  route: null,
  ...over,
})

describe('eventShape', () => {
  it('draws something that lasts as a block', () => {
    const events = [ev({ start: 0, end: 100, value: 50 }), ev({ start: 200, value: 60 })]
    // Duration wins over the numeric value: an infusion is a span, not a reading.
    expect(eventShape(events, false)).toBe('blocks')
  })

  it('draws a numeric series as a line', () => {
    expect(eventShape([ev({ value: 80 }), ev({ value: 90 })], false)).toBe('line')
  })

  it('draws a single numeric point as a dot, with nothing to connect it to', () => {
    expect(eventShape([ev({ value: 80 })], false)).toBe('dots')
  })

  it('draws a categorical series as dots', () => {
    expect(eventShape([ev({ text: 'Sinus' }), ev({ text: 'AFib' })], false)).toBe('dots')
  })

  it('never draws a line on a row holding several concepts', () => {
    // A shared row has no single y scale, so a line across it would be meaningless.
    expect(eventShape([ev({ value: 80 }), ev({ value: 90 })], true)).toBe('dots')
  })

  it('still blocks a mixed row when the events last', () => {
    expect(eventShape([ev({ start: 0, end: 10 })], true)).toBe('blocks')
  })

  it('treats an empty row as dots rather than throwing', () => {
    expect(eventShape([], false)).toBe('dots')
  })
})

describe('shade', () => {
  it('keeps the colour at full strength', () => {
    expect(shade('#3b82f6', 1)).toBe('rgb(59,130,246)')
  })

  it('washes it out to white at zero', () => {
    expect(shade('#3b82f6', 0)).toBe('rgb(255,255,255)')
  })

  it('mixes towards white in between', () => {
    expect(shade('#000000', 0.5)).toBe('rgb(128,128,128)')
  })

  it('clamps out-of-range values instead of producing invalid rgb', () => {
    expect(shade('#3b82f6', 2)).toBe('rgb(59,130,246)')
    expect(shade('#3b82f6', -1)).toBe('rgb(255,255,255)')
  })
})
