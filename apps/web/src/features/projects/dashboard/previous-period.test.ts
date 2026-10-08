import { describe, expect, it } from 'vitest'
import { previousPeriodFilters } from './previous-period'

describe('previousPeriodFilters', () => {
  it('moves a date window back by its own length, keeping the other filters', () => {
    const out = previousPeriodFilters({
      col_unit: { type: 'categorical', selected: ['ICU'] },
      col_date: { type: 'date', from: '2025-07-01', to: '2025-12-31' },
    })
    expect(out?.from).toBe('2025-01-01')
    expect(out?.to).toBe('2025-06-30')
    expect(out?.filters.col_unit).toEqual({ type: 'categorical', selected: ['ICU'] })
    expect(out?.filters.col_date).toEqual({ type: 'date', from: '2025-01-01', to: '2025-06-30' })
  })

  it('moves any other window by its length in days', () => {
    const out = previousPeriodFilters({ col_date: { type: 'date', from: '2025-07-15', to: '2025-08-14' } })
    expect(out?.from).toBe('2025-06-14')
    expect(out?.to).toBe('2025-07-14')
  })

  it('reads the day part of datetime bounds', () => {
    const out = previousPeriodFilters({ col_date: { type: 'date', from: '2025-03-10 08:00:00', to: '2025-03-19 23:00:00' } })
    expect(out?.from).toBe('2025-02-28')
    expect(out?.to).toBe('2025-03-09')
  })

  it('has nothing to compare without a closed date window', () => {
    expect(previousPeriodFilters({})).toBeNull()
    expect(previousPeriodFilters({ col_date: { type: 'date', from: '2025-01-01', to: null } })).toBeNull()
    expect(previousPeriodFilters({
      a: { type: 'date', from: '2025-01-01', to: '2025-02-01' },
      b: { type: 'date', from: '2025-01-01', to: '2025-02-01' },
    })).toBeNull()
  })

  it('resolves a relative window before moving it', () => {
    const out = previousPeriodFilters({ col_date: { type: 'date-relative', count: 1, unit: 'month' } })
    expect(out).not.toBeNull()
    expect(out!.filters.col_date.type).toBe('date')
  })
  it('keeps the whole last day of a previous window taken from a relative one', () => {
    const out = previousPeriodFilters({ col_date: { type: 'date-relative', count: 7, unit: 'day' } })!
    const prev = out.filters.col_date as { type: 'date'; from: string; to: string }
    const lastDay = `${out.to}T18:30:00`
    expect(lastDay <= prev.to).toBe(true)
    expect(`${out.to} 18:30:00` <= prev.to).toBe(true)
    const dayAfter = new Date(Date.parse(`${out.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    expect(dayAfter <= prev.to).toBe(false)
  })
})
