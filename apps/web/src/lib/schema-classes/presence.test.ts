import { describe, expect, it } from 'vitest'
import { withClassRelations } from './inject'
import { absentRelations, relationsPresentIn } from './presence'
import { classRelations, eventRelation } from './relations'
import { mappingV1ToV2, type SchemaMappingV1 } from './v1'

const omop = mappingV1ToV2({
  presetId: 'omop',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth' },
  visitTable: {
    table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime',
    careSiteColumn: 'care_site_id', careSiteNameTable: 'care_site', careSiteNameIdColumn: 'care_site_id', careSiteNameColumn: 'care_site_name',
  },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', extraColumns: { standard_concept: 'standard_concept' } }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
    Device: { table: 'device_exposure', conceptIdColumn: 'device_concept_id', patientIdColumn: 'person_id', dateColumn: 'device_exposure_start_datetime' },
  },
} satisfies SchemaMappingV1)

const ALL = ['person', 'visit_occurrence', 'care_site', 'concept', 'measurement', 'device_exposure']
const without = (...gone: string[]) => ALL.filter((t) => !gone.includes(t))

describe('relationsPresentIn', () => {
  it('leaves every relation as it is when the database has all its tables', () => {
    expect(relationsPresentIn(omop, ALL)).toBe(classRelations(omop))
    expect(absentRelations(omop, ALL)).toEqual([])
  })

  it('empties a relation whose table is missing, keeping its name and columns', () => {
    const device = relationsPresentIn(omop, without('device_exposure')).find((r) => r.key === 'Device')!
    expect(device.name).toBe(eventRelation(omop, 'Device')!.name)
    expect(device.sql).not.toContain('device_exposure')
    expect(device.sql).toMatch(/WHERE false$/)
    expect(device.sql).toContain('CAST(NULL AS BIGINT) AS concept_id')
    expect(device.sql).toContain('CAST(NULL AS TIMESTAMP) AS start_datetime')
    expect(absentRelations(omop, without('device_exposure'))).toEqual([{ specKey: 'events.Device', tables: ['device_exposure'], empty: true }])
  })

  it('drops a left join on a missing table and keeps the relation', () => {
    const visit = relationsPresentIn(omop, without('care_site')).find((r) => r.cls === 'visit')!
    expect(visit.sql).toContain('visit_occurrence')
    expect(visit.sql).not.toContain('care_site"')
    expect(visit.sql).not.toMatch(/WHERE false$/)
    expect(absentRelations(omop, without('care_site'))).toEqual([{ specKey: 'visit', tables: ['care_site'], empty: false }])
  })

  it('keeps the extra columns of an emptied dictionary', () => {
    const dict = relationsPresentIn(omop, without('concept')).find((r) => r.cls === 'concept')!
    expect(dict.sql).toContain('AS extra_standard_concept')
  })

  it('matches tables case-insensitively', () => {
    expect(absentRelations(omop, ALL.map((t) => t.toUpperCase()))).toEqual([])
  })
})

describe('withClassRelations and the tables a database has', () => {
  it('injects the emptied relation, so a union over every event still binds', () => {
    const events = ['Measurement', 'Device'].map((l) => `SELECT concept_id FROM ${eventRelation(omop, l)!.name}`).join(' UNION ALL ')
    const sql = withClassRelations(events, omop, without('device_exposure'))
    expect(sql).toContain('"measurement"')
    expect(sql).not.toContain('device_exposure')
  })

  it('injects the mapping as written when the tables are unknown', () => {
    const sql = withClassRelations(`SELECT * FROM ${eventRelation(omop, 'Device')!.name}`, omop, null)
    expect(sql).toContain('device_exposure')
  })
})
