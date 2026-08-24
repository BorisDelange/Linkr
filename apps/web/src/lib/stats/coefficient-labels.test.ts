import { describe, it, expect } from 'vitest'
import { coefficientRelabeler } from './coefficient-labels'
import type { DatasetColumn } from '@/types'

function col(name: string, label?: string): DatasetColumn {
  return { id: `col_${name}`, name, type: 'string', label } as DatasetColumn
}

describe('coefficientRelabeler', () => {
  it('replaces a plain term with its label', () => {
    const relabel = coefficientRelabeler([col('site', 'Site')])
    expect(relabel('site')).toBe('Site')
  })

  it('keeps the level on a dummy term', () => {
    const relabel = coefficientRelabeler([col('site', 'Site')])
    expect(relabel('site: CH Vannes')).toBe('Site: CH Vannes')
  })

  it('leaves an unlabelled column as it is', () => {
    const relabel = coefficientRelabeler([col('sofa_score')])
    expect(relabel('sofa_score')).toBe('sofa_score')
  })

  it('leaves a term it does not know alone', () => {
    const relabel = coefficientRelabeler([col('site', 'Site')])
    // The intercept, and anything else the caller did not send as a column.
    expect(relabel('(Intercept)')).toBe('(Intercept)')
  })

  it('does not let a shorter name shadow a longer one', () => {
    // The bug this ordering exists for: matching `site` first would turn
    // "site_type: A" into "Site_type: A".
    const relabel = coefficientRelabeler([col('site', 'Site'), col('site_type', 'Site type')])
    expect(relabel('site_type: A')).toBe('Site type: A')
    expect(relabel('site: B')).toBe('Site: B')
  })

  it('does not treat a name that merely starts the same as a dummy', () => {
    const relabel = coefficientRelabeler([col('age', 'Age')])
    // No ": " after `age`, so this is a different column entirely.
    expect(relabel('age_group')).toBe('age_group')
  })

  it('keeps a level that itself contains the separator', () => {
    const relabel = coefficientRelabeler([col('note', 'Note')])
    expect(relabel('note: see: below')).toBe('Note: see: below')
  })
})
