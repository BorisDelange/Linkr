import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Cohort, CohortLevel } from '@/types'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { buildTableStatsSql, buildTablesStatsSql } from './cohort-tables'

// Count all in one query, the members computed once, must give each table the
// counts its own query gives — run here on a real DuckDB.

const mapping = mappingV1ToV2({
  presetId: 't',
  presetLabel: { en: 'T' },
  patientTable: { table: 'patients', idColumn: 'subject_id' },
  visitTable: { table: 'admissions', idColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'admittime', endDateColumn: 'dischtime' },
  visitDetailTable: { table: 'icustays', idColumn: 'stay_id', visitIdColumn: 'hadm_id', patientIdColumn: 'subject_id', startDateColumn: 'intime', endDateColumn: 'outtime' },
} as never)

const SETUP = `
CREATE TABLE patients AS SELECT i AS subject_id FROM range(1, 11) r(i);
CREATE TABLE admissions AS SELECT i * 10 + j AS hadm_id, i AS subject_id, TIMESTAMP '2024-01-01' AS admittime, TIMESTAMP '2024-01-03' AS dischtime FROM range(1, 11) r(i), range(0, 2) s(j);
CREATE TABLE icustays AS SELECT hadm_id * 10 AS stay_id, hadm_id, subject_id, admittime AS intime, dischtime AS outtime FROM admissions WHERE hadm_id % 2 = 0;
CREATE TABLE chartevents AS SELECT stay_id, hadm_id, subject_id, k AS itemid FROM icustays, range(0, 3) r(k);
CREATE TABLE labevents AS SELECT hadm_id, subject_id, k AS itemid FROM admissions, range(0, 2) r(k);
CREATE TABLE diagnoses AS SELECT subject_id, 'I10' AS icd_code FROM patients;
CREATE TABLE d_items AS SELECT 1 AS itemid, 'HR' AS label
`

const TABLES = [
  { name: 'chartevents', columns: ['stay_id', 'hadm_id', 'subject_id', 'itemid'] },
  { name: 'labevents', columns: ['hadm_id', 'subject_id', 'itemid'] },
  { name: 'diagnoses', columns: ['subject_id', 'icd_code'] },
  { name: 'admissions', columns: ['hadm_id', 'subject_id', 'admittime', 'dischtime'] },
  { name: 'd_items', columns: ['itemid', 'label'] },
]

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
  conn.query(withClassRelations(sql, mapping)).toArray().map((row) => row.toJSON() as Record<string, unknown>)

const MEMBERS: Record<Exclude<CohortLevel, 'event'>, string> = {
  patient: 'SELECT subject_id AS patient_id FROM patients WHERE subject_id <= 3',
  visit: 'SELECT hadm_id AS visit_id FROM admissions WHERE hadm_id % 3 = 0',
  visit_detail: 'SELECT stay_id AS visit_detail_id FROM icustays WHERE subject_id IN (2, 5)',
}

const cohort = (level: Exclude<CohortLevel, 'event'>): Cohort => ({
  id: 'c', projectUid: 'p', name: {}, description: {}, level, schemaVersion: 4, createdAt: '', updatedAt: '',
  criteriaTree: { kind: 'group', id: 'r', operator: 'AND', exclude: false, enabled: true, children: [] },
  customSql: MEMBERS[level],
})

describe('every table counted in one query', () => {
  for (const level of ['patient', 'visit', 'visit_detail'] as const) {
    it(`gives each table its own query's counts, at ${level} level`, () => {
      const together = new Map(query(buildTablesStatsSql(cohort(level), mapping, TABLES)!).map((r) => [r.block, r]))
      // The table carrying no id is not filtered, so not counted.
      expect([...together.keys()].sort()).toEqual(['admissions', 'chartevents', 'diagnoses', 'labevents'])
      for (const table of TABLES.filter((t) => together.has(t.name))) {
        const [alone] = query(buildTableStatsSql(cohort(level), mapping, table.name, table.columns)!)
        const row = together.get(table.name)!
        for (const [column, value] of Object.entries(alone)) expect(row[column], `${table.name}.${column}`).toEqual(value)
        expect(Number(row.selected_rows)).toBeGreaterThan(0)
      }
    })
  }
})
