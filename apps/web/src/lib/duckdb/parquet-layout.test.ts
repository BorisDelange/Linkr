import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { MAX_LAYOUT_CHECKS, patientLayoutChecks, unsortedTables, type LayoutEntry } from './parquet-layout'

const mapping = mappingV1ToV2({
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
    Lab: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
  },
} as unknown as SchemaMappingV1)

describe('patientLayoutChecks', () => {
  it('lists each table read by patient once, with its patient column', () => {
    expect(patientLayoutChecks(mapping)).toEqual([
      { table: 'person', column: 'person_id' },
      { table: 'visit_occurrence', column: 'person_id' },
      { table: 'measurement', column: 'person_id' },
    ])
  })

  it('never asks more tables than the server answers', () => {
    const eventTables = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
      `E${i}`, { table: `events_${i}`, conceptIdColumn: 'concept_id', patientIdColumn: 'person_id', dateColumn: 'dt' },
    ]))
    const wide = mappingV1ToV2({ patientTable: { table: 'person', idColumn: 'person_id' }, eventTables } as unknown as SchemaMappingV1)
    expect(patientLayoutChecks(wide)).toHaveLength(MAX_LAYOUT_CHECKS)
  })
})

describe('unsortedTables', () => {
  const e = (table: string, rowGroups: number, scanFraction: number | null): LayoutEntry => ({ table, column: 'person_id', rowGroups, scanFraction })

  it('keeps the tables a lookup reads mostly in full, worst first', () => {
    const out = unsortedTables([e('a', 100, 0.6), e('b', 100, 0.02), e('c', 100, 0.99)])
    expect(out.map((x) => x.table)).toEqual(['c', 'a'])
  })

  it('ignores small tables and missing statistics', () => {
    expect(unsortedTables([e('small', 3, 1), e('nostats', 500, null)])).toEqual([])
  })
})
