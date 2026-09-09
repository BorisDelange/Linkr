import { describe, expect, it } from 'vitest'
import type { DatasetColumn } from '@/types'
import { completionOf, violationOf } from './constraints'

const col = (over: Partial<DatasetColumn> = {}): DatasetColumn => ({
  id: 'col_a', name: 'a', type: 'string', order: 0, ...over,
})

describe('violationOf', () => {
  it('accepts an empty value on an optional field', () => {
    expect(violationOf(col(), null)).toBeNull()
    expect(violationOf(col(), '')).toBeNull()
  })

  it('flags an empty value on a required field', () => {
    expect(violationOf(col({ required: true }), '')?.key).toBe('datasets.constraint_required')
  })

  it('does not flag other constraints on an empty value', () => {
    // An unfilled optional field is not "out of range" — reporting a bound on a
    // blank box would put an error on every field the collector has yet to reach.
    expect(violationOf(col({ type: 'number', min: 5 }), null)).toBeNull()
  })

  it('flags a value outside the allowed vocabulary', () => {
    const c = col({ allowedValues: ['yes', 'no'] })
    expect(violationOf(c, 'maybe')?.key).toBe('datasets.constraint_not_allowed')
    expect(violationOf(c, 'yes')).toBeNull()
  })

  it('compares numbers numerically, not as text', () => {
    // The trap: "10" < "9" as strings, so a text comparison would reject 10.
    const c = col({ type: 'number', min: 9 })
    expect(violationOf(c, 10)).toBeNull()
    expect(violationOf(c, 8)?.key).toBe('datasets.constraint_min')
  })

  it('flags a number above the maximum', () => {
    expect(violationOf(col({ type: 'number', max: 100 }), 101)?.key)
      .toBe('datasets.constraint_max')
  })

  it('flags a non-numeric entry in a number column', () => {
    expect(violationOf(col({ type: 'number' }), 'abc')?.key)
      .toBe('datasets.constraint_not_a_number')
  })

  it('bounds dates by ISO comparison', () => {
    const c = col({ type: 'date', min: '2026-01-01', max: '2026-12-31' })
    expect(violationOf(c, '2026-06-15')).toBeNull()
    expect(violationOf(c, '2025-12-31')?.key).toBe('datasets.constraint_after')
    expect(violationOf(c, '2027-01-01')?.key).toBe('datasets.constraint_before')
  })

  it('keeps a datetime within a day-bounded range', () => {
    // `2026-12-31T08:00` must not read as after `2026-12-31`, which plain string
    // comparison would get wrong if the bound were padded rather than compared as-is.
    const c = col({ type: 'date', withTime: true, min: '2026-01-01' })
    expect(violationOf(c, '2026-01-01T08:00')).toBeNull()
  })
})

describe('completionOf', () => {
  it('counts filled fields and outstanding required ones', () => {
    const fields = [
      { column: col({ id: 'a', required: true }), value: 'x' },
      { column: col({ id: 'b', required: true }), value: null },
      { column: col({ id: 'c' }), value: '' },
    ]
    expect(completionOf(fields)).toEqual({ filled: 1, total: 3, missingRequired: 1 })
  })

  it('reports nothing outstanding when only optional fields are empty', () => {
    const fields = [
      { column: col({ id: 'a', required: true }), value: 'x' },
      { column: col({ id: 'b' }), value: null },
    ]
    expect(completionOf(fields).missingRequired).toBe(0)
  })

  it('treats 0 and false as filled', () => {
    // A measured zero is data; only null and '' are absences.
    const fields = [
      { column: col({ id: 'a', type: 'number' }), value: 0 },
      { column: col({ id: 'b', type: 'boolean' }), value: false },
    ]
    expect(completionOf(fields).filled).toBe(2)
  })
})
