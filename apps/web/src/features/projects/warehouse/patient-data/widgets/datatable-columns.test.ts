import { describe, expect, it } from 'vitest'
import { columnStartLabel, columnsOf, durationLabel, formatCell } from './datatable-columns'

const DAY = 86_400_000
const SHORT = { day: 'd', hour: 'h', minute: 'min' }
const EN = (unit: keyof typeof SHORT, value: string) => `${value} ${SHORT[unit]}`

describe('data table columns', () => {
  it('cuts the window in equal columns', () => {
    expect(columnsOf({ lo: 0, hi: 4 * DAY }, 4).map((c) => [c.lo, c.hi])).toEqual([[0, DAY], [DAY, 2 * DAY], [2 * DAY, 3 * DAY], [3 * DAY, 4 * DAY]])
  })

  it('names a column as precisely as its width needs', () => {
    const t = Date.UTC(2024, 0, 15, 6, 30)
    expect(columnStartLabel(t, DAY, 'en-GB')).not.toMatch(/:/)
    expect(columnStartLabel(t, 6 * 3_600_000, 'en-GB')).toMatch(/:/)
    expect(durationLabel(6 * 3_600_000, 'en', EN)).toBe('6 h')
    expect(durationLabel(2 * DAY, 'en', EN)).toBe('2 d')
    expect(durationLabel(45 * 60_000, 'en', EN)).toBe('45 min')
    expect(durationLabel(1.5 * DAY, 'fr', (unit, value) => `${value} ${unit === 'day' ? 'j' : SHORT[unit]}`)).toBe('1,5 j')
  })

  it('shows the count for a count, the text for a categorical last value', () => {
    expect(formatCell({ value: 3, text: null, n: 12 }, 'count', 'en')).toBe('12')
    expect(formatCell({ value: null, text: 'Sinus rhythm', n: 1 }, 'last', 'en')).toBe('Sinus rhythm')
    expect(formatCell({ value: 98.456, text: null, n: 4 }, 'mean', 'en')).toBe('98.5')
    expect(formatCell({ value: 1.2345, text: null, n: 4 }, 'mean', 'en')).toBe('1.23')
  })
})
