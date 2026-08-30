import { describe, it, expect } from 'vitest'
import { fmtValue, fmtDuration, fmtEventValue, fmtEventWhen } from './event-format'

// The bug these answer: a norepinephrine rate printed as 0.0833333333333 with no
// unit. A clinical figure needs rounding and its unit, or it says nothing.

describe('fmtValue', () => {
  it('rounds a raw float to two decimals', () => {
    expect(fmtValue(0.08333333333333333)).toBe('0.08')
  })

  it('leaves a whole number alone', () => {
    expect(fmtValue(80)).toBe('80')
  })

  it('drops a trailing zero rather than padding', () => {
    expect(fmtValue(1.5)).toBe('1.5')
    expect(fmtValue(1.0)).toBe('1')
  })

  it('goes exponential rather than rounding a tiny value to zero', () => {
    // 0.00 would read as "no dose", which is worse than an exponent.
    expect(fmtValue(0.000003)).toBe('3.00e-6')
  })

  it('goes exponential rather than filling the tooltip', () => {
    expect(fmtValue(12_000_000)).toBe('1.20e+7')
  })

  it('keeps zero as zero', () => {
    expect(fmtValue(0)).toBe('0')
  })

  it('handles a negative value', () => {
    expect(fmtValue(-2.567)).toBe('-2.57')
  })
})

describe('fmtDuration', () => {
  it('reports minutes', () => {
    expect(fmtDuration(25 * 60_000)).toBe('25 min')
  })

  it('reports anything under a minute as under a minute', () => {
    expect(fmtDuration(20_000)).toBe('<1 min')
  })

  it('switches to hours with one decimal', () => {
    expect(fmtDuration(4.5 * 3600_000)).toBe('4.5 h')
  })

  it('drops the decimal once the count is long', () => {
    expect(fmtDuration(30 * 3600_000)).toBe('30 h')
  })

  it('switches to days past two', () => {
    expect(fmtDuration(72 * 3600_000)).toBe('3.0 d')
  })
})

describe('fmtEventValue', () => {
  it('writes the value with its unit', () => {
    expect(fmtEventValue(80, null, 'bpm', 0, null)).toBe('80 bpm')
  })

  it('rounds the value it prints', () => {
    expect(fmtEventValue(0.0833333333, null, 'mcg/kg/min', 0, null)).toBe('0.08 mcg/kg/min')
  })

  it('omits the unit when the schema maps none, rather than inventing one', () => {
    expect(fmtEventValue(80, null, null, 0, null)).toBe('80')
  })

  it('adds the average rate for something infused over time', () => {
    // 500 mg over 2 h → 250 mg/h. Both figures answer half the question.
    const start = 0
    const end = 2 * 3600_000
    expect(fmtEventValue(500, null, 'mg', start, end)).toBe('500 mg · 250 mg/h')
  })

  it('does not divide a value already expressed per hour a second time', () => {
    // The whole point: "50 mL/h · 25 mL/h/h" is confidently wrong.
    const end = 2 * 3600_000
    expect(fmtEventValue(50, null, 'mL/h', 0, end)).toBe('50 mL/h')
  })

  it('recognises a per-minute rate as a rate too', () => {
    const end = 2 * 3600_000
    expect(fmtEventValue(5, null, 'mcg/min', 0, end)).toBe('5 mcg/min')
  })

  it('falls back to the categorical text when there is no number', () => {
    expect(fmtEventValue(null, 'Sinus Rhythm', null, 0, null)).toBe('Sinus Rhythm')
  })

  it('has nothing to show for an empty event', () => {
    expect(fmtEventValue(null, null, 'mg', 0, null)).toBeNull()
  })

  it('skips the rate when the span is not a real duration', () => {
    expect(fmtEventValue(500, null, 'mg', 5000, 5000)).toBe('500 mg')
  })
})

describe('fmtEventWhen', () => {
  it('writes an instant', () => {
    expect(fmtEventWhen(Date.UTC(2024, 0, 15, 14, 30), null)).toBe('2024-01-15 14:30')
  })

  it('writes a span with its duration', () => {
    const start = Date.UTC(2024, 0, 15, 14, 0)
    const end = Date.UTC(2024, 0, 15, 16, 0)
    expect(fmtEventWhen(start, end)).toBe('2024-01-15 14:00 → 2024-01-15 16:00 · 2.0 h')
  })
})
