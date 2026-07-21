import { describe, it, expect } from 'vitest'
import { applyColumnFilter, isCategoricalFilter } from './ColumnFilterInput'
import { coerceValue } from '@/lib/dataset-utils'

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
