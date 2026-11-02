import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import type { TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Cohort, CriteriaTreeNode } from '@/types'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { buildCohortReportModel } from './model'

// The report in one query, the members computed once, must say exactly what it
// says section by section — run here on a real DuckDB.

const t = ((key: string) => key) as unknown as TFunction

const MAPPING = mappingV1ToV2({
  presetId: 'test',
  presetLabel: { en: 'Test' },
  patientTable: { table: 'person', idColumn: 'person_id', genderColumn: 'sex', birthYearColumn: 'born' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'start', endDateColumn: 'stop' },
  visitDetailTable: {
    table: 'unit_stay', idColumn: 'unit_stay_id', visitIdColumn: 'visit_id', patientIdColumn: 'person_id',
    startDateColumn: 'start', endDateColumn: 'stop',
    unitColumn: 'care_site_id', unitNameTable: 'care_site', unitNameIdColumn: 'care_site_id', unitNameColumn: 'care_site_name',
  },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurements: {
      table: 'measurement', conceptIdColumn: 'mc', sourceConceptIdColumn: 'msc', valueColumn: 'v',
      patientIdColumn: 'person_id', dateColumn: 'dt',
    },
  },
} as SchemaMappingV1)

// 40 patients, one stay each through one or two units; heart rate (100) for
// the even ones, a source-coded one (900 → 100) for every fifth.
const SETUP = `
CREATE TABLE person AS SELECT i AS person_id, CASE WHEN i % 3 = 0 THEN 'F' ELSE 'M' END AS sex, 1940 + i AS born FROM range(1, 41) r(i);
CREATE TABLE visit AS SELECT i * 10 AS visit_id, i AS person_id, TIMESTAMP '2023-01-01' + INTERVAL (i * 9) DAY AS start, TIMESTAMP '2023-01-05' + INTERVAL (i * 9) DAY AS stop FROM range(1, 41) r(i);
CREATE TABLE care_site AS SELECT * FROM (VALUES (1, 'ICU'), (2, 'Cardiology')) t(care_site_id, care_site_name);
CREATE TABLE unit_stay AS
  SELECT visit_id * 10 AS unit_stay_id, visit_id, person_id, start, stop, 1 AS care_site_id FROM visit
  UNION ALL SELECT visit_id * 10 + 1, visit_id, person_id, start, stop, 2 FROM visit WHERE person_id % 4 = 0;
CREATE TABLE concept AS SELECT * FROM (VALUES (100, 'Heart rate'), (900, 'HR local')) t(concept_id, concept_name);
CREATE TABLE measurement AS
  SELECT person_id, 100 AS mc, NULL::INTEGER AS msc, 80.0 + person_id AS v, start AS dt FROM visit WHERE person_id % 2 = 0
  UNION ALL SELECT person_id, 0, 100, 90.0, start FROM visit WHERE person_id % 5 = 0
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

const criterion = (id: string, type: string, config: object): CriteriaTreeNode =>
  ({ kind: 'criterion', id, type, enabled: true, operator: 'AND', exclude: false, config }) as unknown as CriteriaTreeNode

function cohort(level: Cohort['level']): Cohort {
  return {
    id: 'c1', projectUid: 'p1', name: { en: 'Heart rate' }, description: {}, level, schemaVersion: 4,
    criteriaTree: {
      kind: 'group', id: 'root', operator: 'AND', exclude: false, enabled: true,
      children: [
        criterion('hr', 'concept', { conceptIds: [100], conceptNames: { 100: 'Heart rate' } }),
        criterion('men', 'sex', { values: ['M'] }),
      ],
    },
  } as unknown as Cohort
}

async function report(level: Cohort['level'], combine: boolean) {
  const sent: string[] = []
  const model = await buildCohortReportModel({
    cohort: cohort(level), mapping: MAPPING, databaseName: 'db', t, locale: 'en', threshold: 1, combine,
    now: new Date('2026-11-02T00:00:00Z'),
    run: async (sql) => {
      sent.push(sql)
      return conn.query(withClassRelations(sql, MAPPING)).toArray().map((row) => row.toJSON() as Record<string, unknown>)
    },
  })
  return { model, sent }
}

describe('the report in one query', () => {
  for (const level of ['patient', 'visit', 'visit_detail'] as const) {
    it(`says what the sections say one by one, at ${level} level`, async () => {
      const one = await report(level, true)
      const each = await report(level, false)
      expect(one.model).toEqual(each.model)
      expect(one.model.concepts[0].patients.value).toBeGreaterThan(0)
      expect(one.model.careUnits.length).toBeGreaterThan(0)
      // The members once, and the one attrition step between the whole table and the cohort.
      expect(one.sent).toHaveLength(2)
    })
  }

  it('counts the last attrition step as the cohort itself', async () => {
    const { model } = await report('patient', true)
    expect(model.flow.at(-1)!.units).toEqual(model.kpis[0].count)
  })
})
