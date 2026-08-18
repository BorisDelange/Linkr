import { describe, it, expect } from 'vitest'
import { toIsoDay, fromIsoDay } from './date-picker-field'

// These two are the whole reason the date field can't just use `new Date(iso)` and
// `toISOString()`: both go through UTC, so a date picked in a timezone east of
// Greenwich comes back as the previous day. The app compares these strings against
// SQL dates, where an off-by-one day is a silently wrong filter.

describe('toIsoDay', () => {
  it('formats a local date without shifting through UTC', () => {
    // Local midnight — toISOString() would render this as the 14th in UTC+n.
    expect(toIsoDay(new Date(2026, 2, 15))).toBe('2026-03-15')
  })

  it('pads month and day to two digits', () => {
    expect(toIsoDay(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('keeps the calendar day for a late-evening time', () => {
    // 23:30 local is the next day in UTC for western-positive offsets.
    expect(toIsoDay(new Date(2026, 6, 9, 23, 30))).toBe('2026-07-09')
  })
})

describe('fromIsoDay', () => {
  it('parses to a local date, not a UTC instant', () => {
    const d = fromIsoDay('2026-03-15')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(2)
    expect(d.getDate()).toBe(15)
  })

  it('returns undefined for empty or malformed input', () => {
    expect(fromIsoDay(undefined)).toBeUndefined()
    expect(fromIsoDay('')).toBeUndefined()
    expect(fromIsoDay('not-a-date')).toBeUndefined()
  })

  it('rejects a partial date rather than inventing a day', () => {
    expect(fromIsoDay('2026-03')).toBeUndefined()
  })
})

describe('round trip', () => {
  it('survives both directions unchanged', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29']) {
      expect(toIsoDay(fromIsoDay(iso)!)).toBe(iso)
    }
  })
})
