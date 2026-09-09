import { describe, expect, it } from 'vitest'
import { identityColumnsFromMapping } from './identity-columns'
import type { SchemaMapping } from '@/types/schema-mapping'

const mimic = {
  patientTable: { table: 'patients', idColumn: 'subject_id' },
  visitTable: { table: 'admissions', idColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'admittime' },
  visitDetailTable: { table: 'icustays', idColumn: 'stay_id', visitIdColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'intime' },
} as unknown as SchemaMapping

describe('identityColumnsFromMapping', () => {
  it('uses the names the active database actually uses', () => {
    // The whole point: the collection joins to MIMIC without a rename, and reads
    // familiarly to whoever fills it.
    expect(identityColumnsFromMapping(mimic).map((c) => c.name))
      .toEqual(['subject_id', 'hadm_id', 'stay_id'])
  })

  it('falls back to OMOP names when there is no mapping', () => {
    expect(identityColumnsFromMapping(undefined).map((c) => c.name))
      .toEqual(['person_id', 'visit_occurrence_id', 'visit_detail_id'])
  })

  it('skips a table the mapping does not declare', () => {
    // A source with no visit_detail table has no unit stays to collect against;
    // offering the column would create a field nothing can ever fill.
    const noDetail = { ...mimic, visitDetailTable: undefined } as unknown as SchemaMapping
    expect(identityColumnsFromMapping(noDetail).map((c) => c.role))
      .toEqual(['person', 'visit'])
  })

  it('keeps the person column even when the mapping declares no patient table', () => {
    // A row must name its patient, so this one is never dropped.
    const bare = {} as SchemaMapping
    const cols = identityColumnsFromMapping(bare)
    expect(cols).toHaveLength(1)
    expect(cols[0]).toEqual({ name: 'person_id', role: 'person', type: 'number' })
  })

  it('returns person, visit, visit detail in that order', () => {
    expect(identityColumnsFromMapping(mimic).map((c) => c.role))
      .toEqual(['person', 'visit', 'visitDetail'])
  })
})
