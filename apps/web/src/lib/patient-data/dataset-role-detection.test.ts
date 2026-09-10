import { describe, expect, it } from 'vitest'
import { detectDatasetRoles } from './dataset-role-detection'
import type { DatasetColumn } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'

const mimic = {
  patientTable: { table: 'patients', idColumn: 'subject_id' },
  visitTable: { table: 'admissions', idColumn: 'hadm_id' },
  visitDetailTable: { table: 'icustays', idColumn: 'stay_id' },
} as unknown as SchemaMapping

/** Columns as the dataset store holds them: id derived from the name. */
function cols(...specs: (string | [string, DatasetColumn['type']])[]): DatasetColumn[] {
  return specs.map((spec, order) => {
    const [name, type] = typeof spec === 'string' ? [spec, 'string' as const] : spec
    return { id: `col_${name}`, name, type, order }
  })
}

describe('detectDatasetRoles', () => {
  it('fills the roles a MIMIC-shaped export gives away', () => {
    const found = detectDatasetRoles(
      cols('subject_id', 'hadm_id', 'stay_id', 'charttime', ['valuenum', 'number']),
      {},
      mimic,
    )
    expect(found).toEqual({
      personColumn: 'col_subject_id',
      visitColumn: 'col_hadm_id',
      visitDetailColumn: 'col_stay_id',
      dateColumn: 'col_charttime',
      valueColumn: 'col_valuenum',
    })
  })

  it('matches on the active database names before the generic ones', () => {
    // Both are plausible patient columns; the mapping decides which one is meant.
    const found = detectDatasetRoles(cols('person_id', 'subject_id'), {}, mimic)
    expect(found.personColumn).toBe('col_subject_id')
  })

  it('falls back to OMOP names with no mapping', () => {
    const found = detectDatasetRoles(
      cols('person_id', 'visit_occurrence_id', 'measurement_datetime'),
      {},
      undefined,
    )
    expect(found.personColumn).toBe('col_person_id')
    expect(found.visitColumn).toBe('col_visit_occurrence_id')
    expect(found.dateColumn).toBe('col_measurement_datetime')
  })

  it('never overwrites a role the user already set', () => {
    const found = detectDatasetRoles(
      cols('subject_id', 'person_id', 'charttime'),
      { personColumn: 'col_person_id' },
      mimic,
    )
    expect(found.personColumn).toBeUndefined()
    expect(found.dateColumn).toBe('col_charttime')
  })

  it('never gives one column two roles', () => {
    // `date` is a candidate for both the start and the end; claiming it twice
    // would draw every event as a zero-length block.
    const found = detectDatasetRoles(cols('person_id', 'date'), {}, undefined)
    expect(found.dateColumn).toBe('col_date')
    expect(found.endColumn).toBeUndefined()
  })

  it('leaves a column already taken by an explicit choice alone', () => {
    const found = detectDatasetRoles(
      cols('charttime', ['valuenum', 'number']),
      { endColumn: 'col_charttime' },
      undefined,
    )
    expect(found.dateColumn).toBeUndefined()
    expect(found.valueColumn).toBe('col_valuenum')
  })

  it('only offers a numeric column as the numeric value', () => {
    // A text `value` column is the text role's business, not the numeric one's —
    // plotting it would yield NaN for every point.
    const found = detectDatasetRoles(cols(['value', 'string']), {}, undefined)
    expect(found.valueColumn).toBeUndefined()
  })

  it('prefers the more specific name over the bare one', () => {
    const found = detectDatasetRoles(
      cols(['value', 'number'], ['value_as_number', 'number']),
      {},
      undefined,
    )
    expect(found.valueColumn).toBe('col_value_as_number')
  })

  it('matches case-insensitively and ignores surrounding space', () => {
    const found = detectDatasetRoles(
      [{ id: 'c1', name: ' Subject_ID ', type: 'number', order: 0 }],
      {},
      mimic,
    )
    expect(found.personColumn).toBe('c1')
  })

  it('finds nothing in a dataset that names nothing recognisably', () => {
    expect(detectDatasetRoles(cols('a', 'b', 'c'), {}, mimic)).toEqual({})
  })

  it('returns nothing for an empty dataset rather than clearing the config', () => {
    expect(detectDatasetRoles([], { personColumn: 'col_x' }, mimic)).toEqual({})
  })
})
