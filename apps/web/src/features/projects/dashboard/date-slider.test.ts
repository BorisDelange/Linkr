import { describe, it, expect } from 'vitest'
import {
  daysBetween,
  addDays,
  toDayBound,
  parseBounds,
  valueToSlider,
  sliderToValue,
} from './date-slider'

describe('daysBetween', () => {
  it('counts whole days forward and backward', () => {
    expect(daysBetween('2024-01-01', '2024-01-11')).toBe(10)
    expect(daysBetween('2024-01-11', '2024-01-01')).toBe(-10)
    expect(daysBetween('2024-01-01', '2024-01-01')).toBe(0)
  })

  it('crosses a leap day', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
  })

  it('is not thrown off by a DST transition', () => {
    // Late March in most of Europe/North America: a naive ms division would give
    // 30.958… days here and round short.
    expect(daysBetween('2024-03-01', '2024-04-01')).toBe(31)
    expect(daysBetween('2024-10-01', '2024-11-01')).toBe(31)
  })

  it('is 0 for an unparseable day', () => {
    expect(daysBetween('', '2024-01-01')).toBe(0)
  })
})

describe('addDays', () => {
  it('moves across month and year ends', () => {
    expect(addDays('2024-01-31', 1)).toBe('2024-02-01')
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
  })

  it('round-trips with daysBetween', () => {
    expect(addDays('2024-06-15', daysBetween('2024-06-15', '2024-09-02'))).toBe('2024-09-02')
  })
})

describe('toDayBound', () => {
  it('trims a stored timestamp to its day', () => {
    // What _date_stats returns, e.g. "2020-01-05 00:00:00".
    expect(toDayBound('2020-01-05 00:00:00')).toBe('2020-01-05')
    expect(toDayBound('2020-01-05T13:22:01Z')).toBe('2020-01-05')
    expect(toDayBound('2020-01-05')).toBe('2020-01-05')
  })

  it('rejects anything that is not a day', () => {
    expect(toDayBound(null)).toBeNull()
    expect(toDayBound('')).toBeNull()
    expect(toDayBound('not a date')).toBeNull()
  })
})

describe('parseBounds', () => {
  it('accepts a well-ordered pair', () => {
    expect(parseBounds('2020-01-01 00:00:00', '2020-12-31 00:00:00'))
      .toEqual({ min: '2020-01-01', max: '2020-12-31' })
  })

  it('rejects a missing or inverted pair', () => {
    expect(parseBounds(null, '2020-12-31')).toBeNull()
    expect(parseBounds('2020-12-31', '2020-01-01')).toBeNull()
  })

  it('accepts a single-day column', () => {
    expect(parseBounds('2020-05-05', '2020-05-05')).toEqual({ min: '2020-05-05', max: '2020-05-05' })
  })
})

describe('valueToSlider / sliderToValue', () => {
  const bounds = { min: '2024-01-01', max: '2024-01-31' } // span = 30

  it('puts an unset filter at both extremes', () => {
    expect(valueToSlider(bounds, null, null)).toEqual([0, 30])
  })

  it('maps dates onto day offsets', () => {
    expect(valueToSlider(bounds, '2024-01-11', '2024-01-21')).toEqual([10, 20])
  })

  it('clamps a value outside the column range', () => {
    expect(valueToSlider(bounds, '2023-06-01', '2025-06-01')).toEqual([0, 30])
  })

  it('reads a full-span selection back as no restriction', () => {
    // Otherwise the filter would count as active while excluding nothing.
    expect(sliderToValue(bounds, [0, 30])).toEqual({ from: null, to: null })
  })

  it('maps offsets back to dates', () => {
    expect(sliderToValue(bounds, [10, 20]))
      .toEqual({ from: '2024-01-11', to: '2024-01-21' })
  })

  it('keeps a half-open window half-open', () => {
    expect(sliderToValue(bounds, [5, 30])).toEqual({ from: '2024-01-06', to: null })
    expect(sliderToValue(bounds, [0, 25])).toEqual({ from: null, to: '2024-01-26' })
  })

  it('round-trips a bounded window', () => {
    const v = sliderToValue(bounds, [3, 27])
    expect(valueToSlider(bounds, v.from, v.to)).toEqual([3, 27])
  })
})
