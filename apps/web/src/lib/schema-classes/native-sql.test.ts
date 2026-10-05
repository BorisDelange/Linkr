import { describe, expect, it } from 'vitest'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { buildCohortCriteriaSql, buildCohortNativeSql } from '@/lib/duckdb/cohort-query'
import { eavMapping } from './__fixtures__/drug-acceptance'
import { toNativeSql } from './native-sql'
import type { Cohort, CohortLevel, SchemaMapping } from '@/types'

// The translations below were also run against the MIMIC-IV demo and an EAV
// warehouse in DuckDB, every criterion type at every level: the native query
// returned exactly the Linkr query's members. These tests pin its shape.

const mimic = mappingV1ToV2({
  presetId: 'mimic', presetLabel: { en: 'MIMIC-IV' },
  patientTable: { schema: 'hosp', table: 'patients', idColumn: 'subject_id', anchorAgeColumn: 'anchor_age', anchorYearColumn: 'anchor_year', genderColumn: 'gender', deathDateColumn: 'dod' },
  visitTable: { schema: 'hosp', table: 'admissions', idColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'admittime', endDateColumn: 'dischtime' },
  visitDetailTable: { schema: 'hosp', table: 'transfers', idColumn: 'transfer_id', visitIdColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'intime', endDateColumn: 'outtime' },
  eventTables: {
    Labs: { schema: 'hosp', table: 'labevents', conceptIdColumn: 'itemid', patientIdColumn: 'subject_id', dateColumn: 'charttime', valueColumn: 'valuenum' },
    Vitals: { schema: 'icu', table: 'chartevents', conceptIdColumn: 'itemid', patientIdColumn: 'subject_id', dateColumn: 'charttime', valueColumn: 'value_num' },
  },
  genderValues: { male: 'M', female: 'F' },
} as never)

let n = 0
const crit = (type: string, config: unknown, extra: object = {}) =>
  ({ kind: 'criterion', id: `c${n++}`, type, config, operator: 'AND', exclude: false, enabled: true, ...extra })
const cohort = (level: CohortLevel, children: unknown[]): Cohort => ({
  id: 'c', projectUid: 'p', name: {}, description: {}, level, schemaVersion: 4, createdAt: '', updatedAt: '',
  criteriaTree: { kind: 'group', id: 'r', operator: 'AND', exclude: false, enabled: true, children: children as never },
})
const noRelation = (sql: string) => expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/linkr_/)

describe('a relation that is one table', () => {
  const sql = buildCohortNativeSql(cohort('visit_detail', [crit('age', { ageReference: 'admission', min: 50 })]), mimic)!

  it('reads the source table under its mapping alias, with no relation left', () => {
    noRelation(sql)
    expect(sql).toContain('FROM\n  hosp.transfers vd\n  INNER JOIN hosp.patients p\n    ON vd.subject_id = p.subject_id')
  })

  it('keeps the level\'s id under its Linkr name, the column the cohort needs', () => {
    expect(sql).toContain('SELECT DISTINCT\n  vd.transfer_id AS visit_detail_id')
  })

  it('writes each column as the expression the mapping gives it', () => {
    expect(sql).toContain("DATE_PART('year', vd.intime::TIMESTAMP) - (p.anchor_year - p.anchor_age) >= 50")
  })
})

describe('column resolution', () => {
  it('resolves one alias to each table it names, per subquery', () => {
    const sql = buildCohortNativeSql(cohort('patient', [
      crit('concept', { eventTableLabel: 'Labs', conceptIds: [1], conceptNames: {}, valueFilters: [{ operator: '>', value: 2 }] }),
      crit('concept', { eventTableLabel: 'Vitals', conceptIds: [2], conceptNames: {}, valueFilters: [{ operator: '>', value: 100 }] }),
    ]), mimic)!
    noRelation(sql)
    // Both EXISTS call their table `e`; each reads its own value column.
    expect(sql).toMatch(/FROM hosp\.labevents e[\s\S]*e\.valuenum > 2[\s\S]*FROM icu\.chartevents e[\s\S]*e\.value_num > 100/)
  })

  it('leaves string literals and comments alone', () => {
    const sql = buildCohortNativeSql(cohort('patient', [crit('id_list', { idLevel: 'patient', ids: ['linkr_patient.patient_id'] })]), mimic)!
    expect(sql).toContain("IN ('linkr_patient.patient_id')")
  })

  it('renames a relation read bare when its mapping alias is taken', () => {
    const sql = toNativeSql('SELECT p.x FROM linkr_visit_detail JOIN linkr_patient vd ON linkr_visit_detail.patient_id = vd.patient_id', mimic)!
    expect(sql).toContain('FROM hosp.transfers vd2 JOIN hosp.patients vd ON vd2.subject_id = vd.subject_id')
  })

  it('quotes a table or schema named by a keyword, which DuckDB cannot read bare', () => {
    const orders = mappingV1ToV2({
      presetId: 'o', presetLabel: { en: 'o' },
      patientTable: { schema: 'from', table: 'order', idColumn: 'id' },
    } as never)
    expect(toNativeSql('SELECT linkr_patient.patient_id FROM linkr_patient', orders)).toContain('FROM "from"."order" ')
  })

  it('gives up rather than leave a relation it cannot follow', () => {
    expect(toNativeSql('SELECT linkr_visit.visit_id FROM admissions', mimic)).toBeNull()
    expect(toNativeSql('SELECT linkr_visit.no_such_column FROM linkr_visit', mimic)).toBeNull()
  })
})

describe('a relation that is more than one table', () => {
  const withJoin: SchemaMapping = {
    ...eavMapping,
    visit: {
      from: { schema: 'eav', table: 'stays', alias: 's' },
      joins: [{ type: 'left', schema: 'eav', table: 'units', alias: 'u', on: [['s.unit', 'u.code']] }],
      fields: { visit_id: 's.stay_id', patient_id: 's.patient_id', start_datetime: 's.admit', end_datetime: 's.discharge' },
    } as never,
  }

  it('stands as its own SELECT, of the columns the query reads only', () => {
    const sql = buildCohortNativeSql(cohort('visit', [crit('period', { startDate: '2024-01-01' })]), withJoin)!
    noRelation(sql)
    expect(sql).toContain('LEFT JOIN "eav"."units" u ON s."unit" = u."code"\n) visit')
    expect(sql).toContain("visit.start_datetime >= '2024-01-01'")
    expect(sql).not.toContain('care_site_name')
  })

  it('inserts hand-written SQL as written when it returns the columns read', () => {
    const sql = buildCohortNativeSql(cohort('patient', [crit('concept', { eventTableLabel: 'Administrations', conceptIds: [42], conceptNames: {} })]), eavMapping)!
    noRelation(sql)
    expect(sql).toContain(`(\n${eavMapping.drugs![0].customSql}\n) e`)
  })

  it('projects it when a column needs the relation\'s fallback', () => {
    // A drug's value is its dose unless mapped: the projection supplies it.
    const sql = buildCohortNativeSql(cohort('patient', [
      crit('concept', { eventTableLabel: 'Administrations', conceptIds: [42], conceptNames: {}, valueFilters: [{ operator: '>=', value: 5 }] }),
    ]), eavMapping)!
    expect(sql).toContain('COALESCE(_c."value_number", COALESCE(_c."amount_value", _c."quantity")) AS value_number')
    expect(sql).toContain('e.value_number >= 5')
  })
})

describe('buildCohortCriteriaSql', () => {
  it('names the id only for the native form', () => {
    const c = cohort('visit', [])
    expect(buildCohortCriteriaSql(c, mimic)).toContain('  linkr_visit.visit_id\nFROM')
    expect(buildCohortCriteriaSql(c, mimic, true)).toContain('  linkr_visit.visit_id AS visit_id\nFROM')
  })
})

describe('an event keyed by (terminology, code)', () => {
  const thesaurus = mappingV1ToV2({
    presetId: 'eav', presetLabel: { en: 'EAV' },
    patientTable: { table: 'persons', idColumn: 'pid' },
    conceptTables: [{ key: 'thes', table: 'thesaurus', idColumn: 'id', nameColumn: 'label', codeColumn: 'code', vocabularyColumn: 'terminology' }],
    eventTables: {
      Data: { table: 'facts', conceptIdColumn: 'code', conceptVocabularyColumn: 'terminology', conceptCodeColumn: 'code', patientIdColumn: 'pid' },
    },
  } as never)

  it('filters on the dictionary id, looked up through the source tables', () => {
    const sql = buildCohortNativeSql(cohort('patient', [
      crit('concept', { eventTableLabel: 'Data', conceptIds: [42], conceptNames: {} }),
    ]), thesaurus)!
    noRelation(sql)
    expect(sql).toContain('REPLACE (_dict.concept_id AS concept_id)')
    expect(sql).toMatch(/LEFT JOIN \(\s*SELECT[\s\S]*d\."id" AS concept_id[\s\S]*FROM "thesaurus" d\s*\) _dict ON _ev\.concept_terminology = _dict\.concept_terminology AND _ev\.concept_code = _dict\.concept_code/)
  })
})
