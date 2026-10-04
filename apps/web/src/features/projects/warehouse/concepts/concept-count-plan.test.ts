import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import {
  buildPatientUnitSql,
  conceptCountProgress,
  conceptCountSignature,
  planConceptCountUnits,
  type ConceptCountManifest,
} from './concept-count-plan'
import { buildConceptsAssembleQuery, buildConceptsQuery, computeAvailableColumns, CONCEPT_COUNTS_VIEW } from './concept-queries'
import { conceptRelations } from '@/lib/schema-classes/relations'
import { absentRelations } from '@/lib/schema-classes/presence'

const v1 = {
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', sourceConceptIdColumn: 'measurement_source_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
    Condition: { table: 'condition_occurrence', conceptIdColumn: 'condition_concept_id', patientIdColumn: 'person_id', dateColumn: 'condition_start_datetime' },
  },
}
const mapping = mappingV1ToV2(v1 as unknown as SchemaMappingV1)
const columns = computeAvailableColumns(conceptRelations(mapping))

describe('planConceptCountUnits', () => {
  it('counts rows per table and concept column, then patients per slice', () => {
    const units = planConceptCountUnits(mapping, [{ hi: 100 }, { lo: 100 }])
    expect(units.map((u) => `${u.step}:${u.key}`)).toEqual([
      'records:records-0-std',
      'records:records-0-src',
      'records:records-1-std',
      'patients:patients-1-of-2',
      'patients:patients-2-of-2',
    ])
  })

  it('never counts a row twice when its source concept repeats the standard one', () => {
    const src = planConceptCountUnits(mapping, [{}]).find((u) => u.key === 'records-0-src')!
    expect(src.sql).toContain('IS DISTINCT FROM e.concept_id')
  })

  it('counts patients over every table at once, within the slice', () => {
    const sql = buildPatientUnitSql(mapping, { lo: 100, hi: 200 })!
    expect(sql).toContain('COUNT(DISTINCT pid)')
    expect(sql).toContain('GROUP BY dict_key, cid')
    expect(sql.match(/UNION ALL/g)).toHaveLength(2)
    expect(sql.match(/e\.patient_id >= 100 AND e\.patient_id < 200/g)).toHaveLength(3)
  })

  it('leaves the whole warehouse unfiltered as a single slice', () => {
    const units = planConceptCountUnits(mapping, [{}])
    const patients = units.filter((u) => u.step === 'patients')
    expect(patients.map((u) => u.key)).toEqual(['patients-1-of-1'])
    expect(patients[0].sql).not.toContain('patient_id >=')
  })

  it('quotes a string slice bound', () => {
    expect(buildPatientUnitSql(mapping, { lo: "a'b" })).toContain("e.patient_id >= 'a''b'")
  })
})

describe('conceptCountSignature', () => {
  it('is stable for the same plan and changes with the slices or the mapping', () => {
    const a = conceptCountSignature(planConceptCountUnits(mapping, [{ hi: 100 }, { lo: 100 }]))
    expect(conceptCountSignature(planConceptCountUnits(mapping, [{ hi: 100 }, { lo: 100 }]))).toBe(a)
    expect(conceptCountSignature(planConceptCountUnits(mapping, [{}]))).not.toBe(a)
    const other = mappingV1ToV2({ ...v1, eventTables: { Measurement: v1.eventTables.Measurement } } as unknown as SchemaMappingV1)
    expect(conceptCountSignature(planConceptCountUnits(other, [{ hi: 100 }, { lo: 100 }]))).not.toBe(a)
  })

  it('changes once a table the database lacked appears, so a resume recounts', () => {
    const units = planConceptCountUnits(mapping, [{}])
    const lacking = absentRelations(mapping, ['person', 'concept', 'measurement'])
    expect(lacking.map((r) => r.specKey)).toEqual(['events.Condition'])
    const before = conceptCountSignature(units, lacking)
    expect(before).not.toBe(conceptCountSignature(units))
    expect(conceptCountSignature(units, absentRelations(mapping, ['person', 'concept', 'measurement', 'condition_occurrence']))).toBe(conceptCountSignature(units))
    expect(conceptCountSignature(units, [...lacking].reverse())).toBe(before)
  })
})

describe('conceptCountProgress', () => {
  const manifest: Partial<ConceptCountManifest> = {
    units: [
      { key: 'records-0-std', step: 'records' },
      { key: 'records-1-std', step: 'records' },
      { key: 'patients-1-of-2', step: 'patients' },
      { key: 'patients-2-of-2', step: 'patients' },
    ],
  }

  it('reports nothing without a run', () => {
    expect(conceptCountProgress(null).state).toBe('none')
  })

  it('counts the units done per step', () => {
    const p = conceptCountProgress({ manifest, doneUnits: ['records-0-std', 'records-1-std', 'patients-1-of-2'] })
    expect(p).toMatchObject({ state: 'partial', records: { done: 2, total: 2 }, patients: { done: 1, total: 2 } })
  })

  it('is complete only once the run marked itself finished with every unit done', () => {
    const all = ['records-0-std', 'records-1-std', 'patients-1-of-2', 'patients-2-of-2']
    expect(conceptCountProgress({ manifest, doneUnits: all }).state).toBe('partial')
    expect(conceptCountProgress({ manifest: { ...manifest, finishedAt: '2026-10-02T10:00:00Z' }, doneUnits: all }).state).toBe('complete')
  })

  it('ignores unit files no longer in the plan', () => {
    const p = conceptCountProgress({ manifest, doneUnits: ['records-9-std'] })
    expect(p.records.done).toBe(0)
  })
})

describe('buildConceptsAssembleQuery', () => {
  it('reads the counts from the units, per dictionary', () => {
    const sql = buildConceptsAssembleQuery(mapping, columns, { recordsComplete: true, patientsComplete: true })!
    expect(sql).toContain(`FROM ${CONCEPT_COUNTS_VIEW}`)
    expect(sql).toContain("WHERE dict_key = 'concept'")
    expect(sql).not.toContain('COUNT(DISTINCT')
  })

  it('leaves a step not yet complete NULL rather than 0', () => {
    const sql = buildConceptsAssembleQuery(mapping, columns, { recordsComplete: true, patientsComplete: false })!
    expect(sql).toContain('COALESCE(_counts.record_count, 0) AS record_count')
    expect(sql).toContain('_counts.patient_count AS patient_count')
    expect(sql).not.toContain('COALESCE(_counts.patient_count')
  })
})

describe('buildConceptsQuery (front-only, counts inline)', () => {
  it('never counts a row twice when its source concept repeats the standard one', () => {
    const sql = buildConceptsQuery(mapping, {}, columns, 0, 50, null)!
    expect(sql).toContain('WHERE source_concept_id IS DISTINCT FROM concept_id')
  })
})

describe('counts the concept table already holds', () => {
  const dict = mapping.concepts![0]
  const alias = dict.from!.alias
  const holding = (fields: Record<string, string>) => ({
    ...mapping,
    concepts: [{ ...dict, fields: { ...dict.fields, ...fields } }],
  })
  const both = holding({ record_count: `${alias}.n_rows`, patient_count: `${alias}.n_patients` })
  const rowsOnly = holding({ record_count: `${alias}.n_rows` })

  it('plans no unit for a count the dictionary holds', () => {
    expect(planConceptCountUnits(both, [{}])).toEqual([])
    expect(planConceptCountUnits(rowsOnly, [{}]).map((u) => u.step)).toEqual(['patients'])
  })

  it('reads a held count from the dictionary, whatever the source', () => {
    const cols = computeAvailableColumns(conceptRelations(both))
    for (const sql of [
      buildConceptsQuery(both, {}, cols, 0, 50, null)!,
      buildConceptsQuery(both, {}, cols, 0, 50, null, { kind: 'none' })!,
      buildConceptsAssembleQuery(both, cols, { recordsComplete: false, patientsComplete: false })!,
    ]) {
      expect(sql).toContain('c.record_count::BIGINT AS record_count')
      expect(sql).toContain('c.patient_count::BIGINT AS patient_count')
      expect(sql).not.toContain('_counts')
    }
  })

  it('still counts the other one', () => {
    const cols = computeAvailableColumns(conceptRelations(rowsOnly))
    const sql = buildConceptsAssembleQuery(rowsOnly, cols, { recordsComplete: true, patientsComplete: true })!
    expect(sql).toContain('c.record_count::BIGINT AS record_count')
    expect(sql).toContain('COALESCE(_counts.patient_count, 0) AS patient_count')
  })
})

describe('buildConceptsQuery, not counted yet', () => {
  it('reads the dictionary alone and leaves the counts empty', () => {
    const sql = buildConceptsQuery(mapping, {}, columns, 0, 50, null, { kind: 'none' })!
    expect(sql).not.toContain('measurement')
    expect(sql).toContain('NULL::BIGINT AS record_count')
    expect(sql).toContain('NULL::BIGINT AS patient_count')
  })
})
