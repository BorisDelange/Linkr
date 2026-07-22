import { describe, it, expect } from 'vitest'
import { applyColumnFilter, isCategoricalFilter } from './ColumnFilterInput'
import { toServerFilters } from './use-server-dataset-rows'
import { coerceValue } from '@/lib/dataset-utils'
import type { DatasetColumn } from '@/types'

const col = (id: string, type: DatasetColumn['type']): DatasetColumn =>
  ({ id, name: id, type }) as DatasetColumn

describe('applyColumnFilter — categorical (list) mode', () => {
  it('matches the cell against the selected values by string form', () => {
    expect(applyColumnFilter('ICU', 'string', { in: ['ICU', 'ER'] })).toBe(true)
    expect(applyColumnFilter('Ward', 'string', { in: ['ICU', 'ER'] })).toBe(false)
  })

  it('matches numeric cells by their string form', () => {
    // A number column forced categorical: 5 selected → cell 5 matches.
    expect(applyColumnFilter(5, 'number', { in: ['5', '7'] })).toBe(true)
    expect(applyColumnFilter(6, 'number', { in: ['5', '7'] })).toBe(false)
  })

  it('empty selection matches everything (no filter)', () => {
    expect(applyColumnFilter('anything', 'string', { in: [] })).toBe(true)
  })

  it('treats a null/empty cell as the empty-string category', () => {
    expect(applyColumnFilter(null, 'string', { in: [''] })).toBe(true)
    expect(applyColumnFilter(null, 'string', { in: ['x'] })).toBe(false)
  })
})

describe('isCategoricalFilter', () => {
  it('detects the { in: [...] } shape only', () => {
    expect(isCategoricalFilter({ in: ['a'] })).toBe(true)
    expect(isCategoricalFilter('text')).toBe(false)
    expect(isCategoricalFilter({ min: 1 })).toBe(false)
    expect(isCategoricalFilter(undefined)).toBe(false)
  })
})

describe('applyColumnFilter — text/number/date still work', () => {
  it('string substring is case-insensitive', () => {
    expect(applyColumnFilter('Hello', 'string', 'ell')).toBe(true)
    expect(applyColumnFilter('Hello', 'string', 'xyz')).toBe(false)
  })
  it('number range', () => {
    expect(applyColumnFilter(5, 'number', { min: 1, max: 10 })).toBe(true)
    expect(applyColumnFilter(11, 'number', { min: 1, max: 10 })).toBe(false)
  })
  it('date range compares lexically (ISO strings sort chronologically)', () => {
    expect(applyColumnFilter('2020-06-15', 'date', { from: '2020-01-01', to: '2020-12-31' })).toBe(true)
    expect(applyColumnFilter('2021-01-01', 'date', { from: '2020-01-01', to: '2020-12-31' })).toBe(false)
    expect(applyColumnFilter(null, 'date', { from: '2020-01-01' })).toBe(false)
  })
  it('boolean matches the selected truth value via parseBoolean, empty target passes all', () => {
    expect(applyColumnFilter('oui', 'boolean', 'true')).toBe(true)
    expect(applyColumnFilter('non', 'boolean', 'true')).toBe(false)
    expect(applyColumnFilter('non', 'boolean', 'false')).toBe(true)
    expect(applyColumnFilter('anything', 'boolean', '')).toBe(true)
    expect(applyColumnFilter('unparseable', 'boolean', 'true')).toBe(false)
  })
})

describe('toServerFilters — UI filter → server payload', () => {
  const columns = [col('c_num', 'number'), col('c_date', 'date'), col('c_str', 'string')]

  it('maps a categorical selection to { colId, values } and skips an empty selection', () => {
    expect(toServerFilters({ c_str: { in: ['ICU', 'ER'] } }, columns)).toEqual([{ colId: 'c_str', values: ['ICU', 'ER'] }])
    expect(toServerFilters({ c_str: { in: [] } }, columns)).toEqual([])
  })

  it('maps number/date/string filters by column type', () => {
    expect(toServerFilters({ c_num: { min: 1, max: 10 } }, columns)).toEqual([{ colId: 'c_num', min: 1, max: 10 }])
    expect(toServerFilters({ c_date: { from: '2020-01-01', to: '2020-12-31' } }, columns)).toEqual([{ colId: 'c_date', from: '2020-01-01', to: '2020-12-31' }])
    expect(toServerFilters({ c_str: 'sepsis' }, columns)).toEqual([{ colId: 'c_str', value: 'sepsis' }])
  })

  it('drops null filter values', () => {
    expect(toServerFilters({ c_num: null as never }, columns)).toEqual([])
  })
})

describe('coerceValue — mirrors the server _coerce after a type override', () => {
  it('number: parseable → number, else the original string', () => {
    expect(coerceValue('7', 'number')).toBe(7)
    expect(coerceValue('3.5', 'number')).toBe(3.5)
    expect(coerceValue('G894', 'number')).toBe('G894')
  })
  it('boolean: known token → bool, else the string', () => {
    expect(coerceValue('yes', 'boolean')).toBe(true)
    expect(coerceValue('non', 'boolean')).toBe(false)
    expect(coerceValue('maybe', 'boolean')).toBe('maybe')
  })
  it('empty → null; string/date keep the original text', () => {
    expect(coerceValue('', 'number')).toBeNull()
    expect(coerceValue(null, 'string')).toBeNull()
    expect(coerceValue('2020-01-02', 'date')).toBe('2020-01-02')
    expect(coerceValue('hello', 'string')).toBe('hello')
  })
})
