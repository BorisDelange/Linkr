import { describe, it, expect } from 'vitest'
import { columnId, buildColumnIds, uniqueColumnId } from './column-id'
import fixture from './column-id.fixture.json'

describe('buildColumnIds — shared parity fixture', () => {
  // The same fixture is asserted by apps/api tests/test_column_id.py; both must
  // agree so client and server derive identical ids for the same names.
  for (const [i, c] of fixture.cases.entries()) {
    it(`case ${i}: ${JSON.stringify(c.names)}`, () => {
      expect(buildColumnIds(c.names)).toEqual(c.ids)
    })
  }
})

describe('columnId — single name', () => {
  it('slugifies accents, case, punctuation into col_<slug>', () => {
    expect(columnId('Âge')).toBe('col_age')
    expect(columnId('hospit_unit')).toBe('col_hospit_unit')
    expect(columnId('mean SpO2 (%)')).toBe('col_mean_spo2')
  })
  it('folds empty/whitespace/punct-only names to col_col', () => {
    expect(columnId('')).toBe('col_col')
    expect(columnId('   ')).toBe('col_col')
    expect(columnId('!!!')).toBe('col_col')
  })
  it('is deterministic (same name → same id)', () => {
    expect(columnId('hospit_unit')).toBe(columnId('hospit_unit'))
  })
})

describe('uniqueColumnId — collision suffixes against an existing set', () => {
  it('appends _2, _3 in order', () => {
    const taken = new Set<string>()
    expect(uniqueColumnId('sex', taken)).toBe('col_sex')
    expect(uniqueColumnId('sex', taken)).toBe('col_sex_2')
    expect(uniqueColumnId('sex', taken)).toBe('col_sex_3')
  })
})
