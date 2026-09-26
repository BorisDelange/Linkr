import { describe, expect, it, vi } from 'vitest'

vi.mock('./engine', () => ({ queryDataSource: vi.fn(), discoverTables: vi.fn(), schemaName: vi.fn() }))

import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { generateSchemaChecks } from './data-quality'

const mapping = mappingV1ToV2({
  presetId: 'omop',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime' },
  eventTables: { Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_datetime' } },
})

describe('schema checks on the class relations', () => {
  it('checks that each relation fills its required columns and keeps one row per id', () => {
    const checks = generateSchemaChecks(mapping, ['person', 'visit_occurrence', 'measurement'])
    const contract = checks.find((c) => c.id === 'schema_relation_contract_linkr_visit')!
    expect(contract.sql).toContain('WHERE visit_id IS NULL OR patient_id IS NULL OR start_datetime IS NULL')
    expect(contract.sql).toContain('FROM linkr_visit')
    const unique = checks.find((c) => c.id === 'schema_relation_unique_linkr_patient')!
    expect(unique.sql).toContain('COUNT(*) - COUNT(DISTINCT patient_id)')
    // An event relation has no grain id of its own.
    expect(checks.some((c) => c.id === 'schema_relation_unique_linkr_event_measurement')).toBe(false)
    expect(checks.some((c) => c.id === 'schema_relation_contract_linkr_event_measurement')).toBe(true)
  })

  it('leaves out a relation whose table is missing: it cannot run', () => {
    const checks = generateSchemaChecks(mapping, ['person'])
    expect(checks.some((c) => c.id === 'schema_relation_contract_linkr_visit')).toBe(false)
    expect(checks.find((c) => c.id === 'schema_table_exists_visit_occurrence')?.sql).toContain('SELECT 1::BIGINT AS violated_rows')
  })
})
