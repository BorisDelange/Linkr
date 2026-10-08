import { describe, it, expect } from 'vitest'
import { applyFilters } from './DashboardDataProvider'

const rows = [
  { d: '2024-01-04 09:00:00' },
  { d: '2024-01-05 10:00:00' },
  { d: '2024-01-06 00:00:00' },
  { d: null },
]

describe('applyFilters date', () => {
  it('keeps the whole end day of a timestamp column under a day bound', () => {
    const out = applyFilters(rows, { d: { type: 'date', from: '2024-01-05', to: '2024-01-05' } })
    expect(out).toEqual([{ d: '2024-01-05 10:00:00' }])
  })

  it('drops missing dates once a bound is set, keeps them without one', () => {
    expect(applyFilters(rows, { d: { type: 'date', from: '2024-01-01', to: null } })).toHaveLength(3)
    expect(applyFilters(rows, { d: { type: 'date', from: null, to: null } })).toHaveLength(4)
  })
})
