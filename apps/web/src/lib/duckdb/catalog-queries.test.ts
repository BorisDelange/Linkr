import { describe, it, expect } from 'vitest'
import { generatePeriodIntervals } from './catalog-queries'

// Pure temporal logic — boundary dates and interval counts must be exact,
// since the catalog aggregates clinical activity per period.
describe('generatePeriodIntervals', () => {
  it('always prepends an ALL interval', () => {
    const out = generatePeriodIntervals('2024-01-01', '2024-01-31', 'month')
    expect(out[0]).toEqual({ granularity: 'all', start: '', end: '', label: 'ALL' })
  })

  it('produces one interval per month, with correct inclusive end dates', () => {
    const out = generatePeriodIntervals('2024-01-15', '2024-03-20', 'month')
    const months = out.filter((i) => i.granularity === 'month')
    expect(months).toHaveLength(3)
    expect(months[0].start).toBe('2024-01-01')
    expect(months[0].end).toBe('2024-01-31')
    // February 2024 is a leap year → 29 days.
    expect(months[1].end).toBe('2024-02-29')
    expect(months[2].start).toBe('2024-03-01')
    expect(months[2].end).toBe('2024-03-31')
  })

  it('produces quarter intervals aligned to calendar quarters', () => {
    const out = generatePeriodIntervals('2024-02-10', '2024-08-01', 'quarter')
    const quarters = out.filter((i) => i.granularity === 'quarter')
    // Feb → Q1, Aug → Q3 ⇒ Q1, Q2, Q3.
    expect(quarters.map((q) => q.label)).toEqual(['Q1 2024', 'Q2 2024', 'Q3 2024'])
    expect(quarters[0].start).toBe('2024-01-01')
    expect(quarters[0].end).toBe('2024-03-31')
    expect(quarters[2].end).toBe('2024-09-30')
  })

  it('produces one interval per calendar year spanned', () => {
    const out = generatePeriodIntervals('2022-06-01', '2024-02-01', 'year')
    const years = out.filter((i) => i.granularity === 'year')
    expect(years.map((y) => y.label)).toEqual(['2022', '2023', '2024'])
    expect(years[0]).toMatchObject({ start: '2022-01-01', end: '2022-12-31' })
  })

  it('handles a range within a single month', () => {
    const out = generatePeriodIntervals('2024-05-03', '2024-05-20', 'month')
    expect(out.filter((i) => i.granularity === 'month')).toHaveLength(1)
  })
})
