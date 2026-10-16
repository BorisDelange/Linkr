import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { conceptRelations, eventRelations } from '@/lib/schema-classes/relations'
import { countedRelationSignature } from '@/features/projects/warehouse/concepts/concept-count-plan'
import { buildTimelineQuery } from '@/lib/duckdb/patient-data-queries'
import { relationsWithout } from './timeline-relations'

const mapping = mappingV1ToV2({
  patientTable: { table: 'person', idColumn: 'person_id' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime', valueColumn: 'value_as_number' },
    Observation: { table: 'observation', conceptIdColumn: 'observation_concept_id', patientIdColumn: 'person_id', dateColumn: 'observation_datetime', valueColumn: 'value_as_number' },
  },
} as unknown as SchemaMappingV1)
const [measurement, observation] = eventRelations(mapping)
const dict = conceptRelations(mapping)[0]
const sig = (e: typeof measurement) => countedRelationSignature(e, dict)

describe('relationsWithout', () => {
  it('leaves out a counted relation holding none of the concepts', () => {
    const counted = [
      { relation: measurement.name, signature: sig(measurement), holds: true },
      { relation: observation.name, signature: sig(observation), holds: false },
    ]
    expect([...relationsWithout(mapping, counted)]).toEqual([observation.name])
  })

  it('reads a relation counted under other SQL, or not counted', () => {
    expect(relationsWithout(mapping, [{ relation: observation.name, signature: 'older', holds: false }]).size).toBe(0)
    expect(relationsWithout(mapping, []).size).toBe(0)
  })

  it('reads a relation one of whose units holds the concepts', () => {
    const counted = [
      { relation: observation.name, signature: sig(observation), holds: false },
      { relation: observation.name, signature: sig(observation), holds: true },
    ]
    expect(relationsWithout(mapping, counted).size).toBe(0)
  })
})

describe('buildTimelineQuery without relations', () => {
  it('drops their branch', () => {
    const all = buildTimelineQuery(mapping, [1], 'p1', null)!
    const some = buildTimelineQuery(mapping, [1], 'p1', null, new Set([observation.name]))!
    expect(all).toContain(`FROM ${observation.name} e`)
    expect(some).not.toContain(`FROM ${observation.name} e`)
    expect(some).toContain(`FROM ${measurement.name} e`)
    expect(buildTimelineQuery(mapping, [1], 'p1', null, new Set([measurement.name, observation.name]))).toBeNull()
  })
})
