import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { NO_SCOPE } from '@/lib/duckdb/patient-scope'
import { overviewProbeQueries } from './overview-plan'

const mapping = mappingV1ToV2({
  patientTable: { table: 'person', idColumn: 'person_id', deathDateColumn: 'death_datetime' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
    Condition: { table: 'condition_occurrence', conceptIdColumn: 'condition_concept_id', patientIdColumn: 'person_id', dateColumn: 'condition_start_datetime' },
  },
} as unknown as SchemaMappingV1)

describe('overviewProbeQueries', () => {
  it('asks about every kind of query, for every event table, whatever the patient', () => {
    const probes = overviewProbeQueries(mapping, NO_SCOPE)
    expect(probes.some((q) => q.includes('event_count'))).toBe(true)
    expect(probes.filter((q) => q.includes('AS row_key')).length).toBe(2)
    expect(probes.filter((q) => q.includes('AS event_start')).length).toBe(2)
    expect(overviewProbeQueries(mapping, NO_SCOPE)).toEqual(probes)
  })
})
