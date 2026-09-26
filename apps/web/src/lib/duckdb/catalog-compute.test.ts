import { describe, expect, it } from 'vitest'
import { parsePeriodRow } from './catalog-compute'

const interval = { granularity: 'month' as const, start: '2020-01-01', end: '2020-01-31', label: 'Jan 2020' }

describe('parsePeriodRow', () => {
  it('masks a cell’s stays and rows on its patient count, not on their own value', () => {
    const row = parsePeriodRow(
      {
        n_patients: 3, n_sejours: 40,
        svc_ICU_pat: 2, svc_ICU_sej: 25,
        cat_Lab_pat: 12, cat_Lab_rows: 300,
      },
      interval, [], ['ICU'], ['Lab'], 10,
    )
    expect(row.n_patients).toBeNull()
    expect(row.n_sejours).toBeNull()
    expect(row.services.ICU).toEqual({ n_patients: null, n_sejours: null })
    expect(row.concept_categories.Lab).toEqual({ n_patients: 12, n_rows: 300 })
  })

  it('keeps small stay counts when the patient count clears the threshold', () => {
    const row = parsePeriodRow({ n_patients: 15, n_sejours: 15 }, interval, [], [], [], 10)
    expect(row.n_sejours).toBe(15)
  })
})
