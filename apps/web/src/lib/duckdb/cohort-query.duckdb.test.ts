import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Cohort, CohortLevel, CriteriaTreeNode } from '@/types'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { buildCohortCountSql, buildCohortResultsSql } from './cohort-query'

// A run reads its rows and the cohort's size from one query — run here on a real
// DuckDB: the size counts every member, not the page the LIMIT keeps, and the
// rows still carry the patient columns read after the page is cut.

const MAPPING_V1: SchemaMappingV1 = {
  presetId: 'test',
  presetLabel: { en: 'Test' },
  patientTable: { table: 'person', idColumn: 'person_id', genderColumn: 'sex', birthYearColumn: 'born' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'start', endDateColumn: 'stop' },
  visitDetailTable: {
    table: 'unit_stay', idColumn: 'unit_stay_id', visitIdColumn: 'visit_id', patientIdColumn: 'person_id',
    startDateColumn: 'start', endDateColumn: 'stop',
  },
}
const MAPPING = mappingV1ToV2(MAPPING_V1)

// Five patients, three of them women; patient 3 has two stays, the first of
// them through two units.
const SETUP = `
CREATE TABLE person AS SELECT * FROM (VALUES
  (1, 'M', 1950), (2, 'F', 1960), (3, 'F', 1970), (4, 'M', 1980), (5, 'F', 1990)
) t(person_id, sex, born);
CREATE TABLE visit AS SELECT * FROM (VALUES
  (10, 1, TIMESTAMP '2020-01-01', TIMESTAMP '2020-01-05'),
  (20, 2, TIMESTAMP '2021-01-01', TIMESTAMP '2021-01-05'),
  (30, 3, TIMESTAMP '2022-01-01', TIMESTAMP '2022-01-05'),
  (31, 3, TIMESTAMP '2010-01-01', TIMESTAMP '2010-01-05'),
  (40, 4, TIMESTAMP '2023-01-01', TIMESTAMP '2023-01-05'),
  (50, 5, TIMESTAMP '2024-01-01', TIMESTAMP '2024-01-05')
) t(visit_id, person_id, start, stop);
CREATE TABLE unit_stay AS SELECT visit_id * 10 AS unit_stay_id, visit_id, person_id, start, stop FROM visit
UNION ALL SELECT 301, 30, 3, TIMESTAMP '2022-01-03', TIMESTAMP '2022-01-05'
`

let conn: duckdb.DuckDBConnection

beforeAll(async () => {
  const dist = dirname(createRequire(import.meta.url).resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'))
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs') },
      eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: join(dist, 'duckdb-node-eh.worker.cjs') },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  )
  await db.instantiate()
  db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true } })
  conn = db.connect()
  for (const stmt of SETUP.split(';').map((s) => s.trim()).filter(Boolean)) conn.query(stmt)
}, 60_000)

const query = (sql: string) =>
  conn.query(withClassRelations(sql, MAPPING)).toArray().map((row) => row.toJSON() as Record<string, unknown>)

const women: CriteriaTreeNode = {
  kind: 'criterion', id: 'w', type: 'sex', enabled: true, operator: 'AND', exclude: false, config: { values: ['F'] },
} as CriteriaTreeNode

function cohort(level: CohortLevel, children: CriteriaTreeNode[] = [women]): Cohort {
  return {
    id: 'c1', projectUid: 'p1', name: { en: 'c' }, description: {}, level, schemaVersion: 4,
    criteriaTree: { kind: 'group', id: 'root', operator: 'AND', children, exclude: false, enabled: true },
  } as unknown as Cohort
}

describe('cohort results with their size', () => {
  it('counts every member while the LIMIT keeps the first ones', () => {
    const rows = query(buildCohortResultsSql(cohort('patient'), MAPPING, 2)!)
    expect(rows.map((r) => r.patient_id)).toEqual([2, 3])
    expect(rows.map((r) => r.cohort_total)).toEqual([3, 3])
    expect(query(buildCohortCountSql(cohort('patient'), MAPPING)!)[0].cnt).toBe(3)
  })

  it('reads the age at the first stay on the kept rows', () => {
    const rows = query(buildCohortResultsSql(cohort('patient'), MAPPING, 10)!)
    expect(rows.map((r) => [r.patient_id, r.gender, r.age_at_admission])).toEqual([[2, 'F', 61], [3, 'F', 40], [5, 'F', 34]])
  })

  it('counts stays at visit level, a patient with two stays twice', () => {
    const rows = query(buildCohortResultsSql(cohort('visit'), MAPPING, 1)!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ visit_id: 20, patient_id: 2, cohort_total: 4 })
  })

  it('counts unit stays at visit-detail level, with their stay', () => {
    const rows = query(buildCohortResultsSql(cohort('visit_detail'), MAPPING, 2)!)
    expect(rows.map((r) => [r.visit_detail_id, r.visit_id, r.patient_id, r.cohort_total])).toEqual([[200, 20, 2, 5], [300, 30, 3, 5]])
    expect(rows[0]).toMatchObject({ gender: 'F', age_at_admission: 61 })
  })

  it('counts the whole table without a criterion', () => {
    expect(query(buildCohortResultsSql(cohort('patient', []), MAPPING, 10)!)[0].cohort_total).toBe(5)
  })

  it('returns no row for an empty cohort', () => {
    const none = { ...women, config: { values: ['X'] } } as CriteriaTreeNode
    expect(query(buildCohortResultsSql(cohort('patient', [none]), MAPPING, 10)!)).toEqual([])
  })
})
