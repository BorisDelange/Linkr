import { describe, expect, it } from 'vitest'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { buildTableRowsSql, buildTableStatsSql, classifyTable, nativeIdColumns, tableIdColumns } from './cohort-tables'
import type { Cohort, CohortLevel } from '@/types'

// A MIMIC-like mapping: the database names its ids its own way.
const mapping = mappingV1ToV2({
  presetId: 't',
  presetLabel: { en: 'T' },
  patientTable: { table: 'patients', idColumn: 'subject_id' },
  visitTable: { table: 'admissions', idColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'admittime', endDateColumn: 'dischtime' },
  visitDetailTable: { table: 'icustays', idColumn: 'stay_id', visitIdColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'intime', endDateColumn: 'outtime' },
} as never)
const ids = nativeIdColumns(mapping)

const cohort = (level: CohortLevel): Cohort => ({
  id: 'c', projectUid: 'p', name: {}, description: {}, level, schemaVersion: 4, createdAt: '', updatedAt: '',
  criteriaTree: { kind: 'group', id: 'r', operator: 'AND', exclude: false, enabled: true, children: [] },
})

describe('nativeIdColumns', () => {
  it('reads each id under the database\'s own column name', () => {
    expect([...ids.patient]).toEqual(['subject_id'])
    expect([...ids.visit]).toEqual(['hadm_id'])
    expect([...ids.visitDetail]).toEqual(['stay_id'])
  })
})

// Same rule as the server's cohort_derive.classify: the Tables tab must show the
// subset a derivation copies.
describe('classifyTable', () => {
  const chartevents = ['subject_id', 'hadm_id', 'STAY_ID', 'itemid']
  const labevents = ['subject_id', 'hadm_id', 'itemid']
  const diagnoses = ['subject_id', 'icd_code']
  const vocabulary = ['itemid', 'label']

  it('keeps a unit-stay cohort\'s unit stays, their parent stays, or their patients', () => {
    expect(classifyTable(chartevents, 'visit_detail', ids)).toEqual({ kind: 'visit_detail', column: 'STAY_ID' })
    expect(classifyTable(labevents, 'visit_detail', ids)).toEqual({ kind: 'parent_visit', column: 'hadm_id' })
    expect(classifyTable(diagnoses, 'visit_detail', ids)).toEqual({ kind: 'patient', column: 'subject_id' })
  })

  it('filters a stay cohort on the stay, and a patient cohort on the patient', () => {
    expect(classifyTable(chartevents, 'visit', ids)).toEqual({ kind: 'visit', column: 'hadm_id' })
    expect(classifyTable(chartevents, 'patient', ids)).toEqual({ kind: 'patient', column: 'subject_id' })
  })

  it('leaves a table with no id unfiltered', () => {
    expect(classifyTable(vocabulary, 'patient', ids)).toBeNull()
  })

  it('lists the ids a table carries, finest first', () => {
    expect(tableIdColumns(chartevents, ids).map((c) => c.kind)).toEqual(['visit_detail', 'visit', 'patient'])
  })
})

describe('table queries', () => {
  it('counts the cohort\'s rows beside all of them, and the distinct ids of each', () => {
    const sql = buildTableStatsSql(cohort('visit_detail'), mapping, 'icu.chartevents', ['subject_id', 'hadm_id', 'stay_id'])!
    expect(sql).toContain('FROM "icu"."chartevents" t')
    expect(sql).toContain('LEFT JOIN k ON t."stay_id" = k.key')
    expect(sql).toContain('COUNT(DISTINCT t."subject_id") FILTER (WHERE k.key IS NOT NULL) AS selected_patient')
    expect(sql).toContain('COUNT(DISTINCT t."hadm_id") AS all_visit')
  })

  it('reaches parent stays through the unit-stay relation', () => {
    const sql = buildTableStatsSql(cohort('visit_detail'), mapping, 'labevents', ['subject_id', 'hadm_id'])!
    expect(sql).toContain('SELECT DISTINCT linkr_visit_detail.visit_id AS key FROM linkr_visit_detail')
  })

  it('has nothing to count for an unfiltered table, and shows its first rows', () => {
    expect(buildTableStatsSql(cohort('patient'), mapping, 'd_items', ['itemid'])).toBeNull()
    expect(buildTableRowsSql(cohort('patient'), mapping, 'd_items', ['itemid'], 50)).toBe('SELECT * FROM "d_items" LIMIT 50')
  })

  it('browses only the cohort\'s rows', () => {
    const sql = buildTableRowsSql(cohort('patient'), mapping, 'diagnoses', ['subject_id'], 200)!
    expect(sql).toContain('WHERE t."subject_id" IN (SELECT key FROM k)')
    expect(sql).toMatch(/LIMIT 200$/)
  })
})
