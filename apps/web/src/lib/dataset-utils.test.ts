import { describe, it, expect } from 'vitest'
import {
  inferColumnType,
  coerceValue,
  isMissingValue,
  normalizeNaValues,
  DEFAULT_NA_VALUES,
} from './dataset-utils'

describe('normalizeNaValues', () => {
  it('defaults to the built-in token list', () => {
    expect(normalizeNaValues().has('na')).toBe(true)
    expect(normalizeNaValues().has('n/a')).toBe(true)
  })

  it('lower-cases, trims and drops blanks from a custom list', () => {
    const set = normalizeNaValues([' MISSING ', 'Void', '', '   '])
    expect(set).toEqual(new Set(['missing', 'void']))
  })

  it('an empty list disables NA detection entirely', () => {
    expect(normalizeNaValues([]).size).toBe(0)
  })
})

describe('isMissingValue', () => {
  const na = normalizeNaValues()

  it('treats null, undefined and blank strings as missing', () => {
    expect(isMissingValue(null, na)).toBe(true)
    expect(isMissingValue(undefined, na)).toBe(true)
    expect(isMissingValue('', na)).toBe(true)
    expect(isMissingValue('   ', na)).toBe(true)
  })

  it('matches NA tokens case-insensitively and ignores surrounding space', () => {
    expect(isMissingValue('NA', na)).toBe(true)
    expect(isMissingValue(' n/a ', na)).toBe(true)
    expect(isMissingValue('NULL', na)).toBe(true)
  })

  it('leaves real content alone', () => {
    expect(isMissingValue('0', na)).toBe(false)
    expect(isMissingValue('banana', na)).toBe(false)
  })
})

describe('inferColumnType — NA handling', () => {
  it('infers number when NA tokens are mixed in', () => {
    // The reported case: "NA", "NA", "13" must not read as a string column.
    expect(inferColumnType(['NA', 'NA', '13'])).toBe('number')
  })

  it('infers number when real data only starts after a long NA run', () => {
    const values = [...Array(19).fill('NA'), ...Array(41).fill('120.5')]
    expect(inferColumnType(values)).toBe('number')
  })

  it('looks past more than 200 leading NA values', () => {
    // The 200-value cap applies to present values, so a long gap can't exhaust it.
    expect(inferColumnType([...Array(500).fill('NA'), '42'])).toBe('number')
  })

  it('returns unknown for an all-NA column', () => {
    expect(inferColumnType(['NA', 'NA', 'NA'])).toBe('unknown')
  })

  it('does not treat "-" or "." as missing by default', () => {
    // They are legitimate content in some columns; opting in is the user's call.
    expect(inferColumnType(['-', '5'])).toBe('string')
    expect(inferColumnType(['.', '5'])).toBe('string')
  })

  it('honours a custom NA list of sentinels', () => {
    expect(inferColumnType(['-', '.', '5', '7'], ['-', '.'])).toBe('number')
  })

  it('an empty NA list makes "NA" ordinary content again', () => {
    expect(inferColumnType(['NA', '13'], [])).toBe('string')
  })

  it('still infers boolean and date around NA values', () => {
    expect(inferColumnType(['true', 'NA', 'false'])).toBe('boolean')
    expect(inferColumnType(['2026-01-02', 'NA', '2026-03-04'])).toBe('date')
  })
})

describe('coerceValue — NA handling', () => {
  it('maps NA tokens to null for every type', () => {
    expect(coerceValue('NA', 'number')).toBe(null)
    expect(coerceValue('n/a', 'string')).toBe(null)
    expect(coerceValue('NULL', 'boolean')).toBe(null)
  })

  it('leaves genuine values untouched', () => {
    expect(coerceValue('13', 'number')).toBe(13)
    expect(coerceValue('true', 'boolean')).toBe(true)
    expect(coerceValue('ICU', 'string')).toBe('ICU')
  })

  it('keeps an unparseable number as its original string', () => {
    expect(coerceValue('abc', 'number')).toBe('abc')
  })

  it('respects a custom NA list', () => {
    expect(coerceValue('-', 'number', ['-'])).toBe(null)
    expect(coerceValue('-', 'number')).toBe('-')
  })

  it('exposes a non-empty default token list', () => {
    expect(DEFAULT_NA_VALUES.length).toBeGreaterThan(0)
  })
})
