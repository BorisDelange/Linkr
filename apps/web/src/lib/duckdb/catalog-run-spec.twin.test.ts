/**
 * A catalog computation compiled here (`compileCatalogRunSpec`) and run by the
 * server (apps/api tests/test_catalog_run_twin.py) stores the cache the
 * browser's own run stores over the same data. This writes, beside the spec,
 * the tables' SQL, every query the browser ran with its rows, the filler's
 * answers, the final cache and one paused among the crossings; the server's
 * test plans from those rows, then runs the spec on the tables as Parquet. The
 * same for the crossings' size estimate (kind `catalog_estimate`).
 *
 * To regenerate after an intentional change:
 *   GOLDEN_UPDATE=1 npx vitest run src/lib/duckdb/catalog-run-spec.twin.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { withClassRelations } from '@/lib/schema-classes/inject'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { CATALOG_VARIABLE_ORDER, type CatalogVariableId } from '@/types/catalog'
import { estimateCrossings, type CrossingEstimate } from './catalog-compute'
import { runCatalogComputation } from './catalog-run'
import { compileCatalogEstimateSpec, compileCatalogRunSpec } from './catalog-run-spec'
import { fillCatalogSql, type CatalogFill } from './catalog-sql-fill'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/catalog-runs/run-spec.json')

const MAPPING_V1: SchemaMappingV1 = {
  presetId: 'twin',
  presetLabel: { en: 'Twin' },
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'vstart', endDateColumn: 'vend', typeColumn: 'vtype' },
  visitDetailTable: {
    table: 'unit_stay', idColumn: 'unit_stay_id', visitIdColumn: 'visit_id', patientIdColumn: 'person_id',
    startDateColumn: 'ustart', endDateColumn: 'uend', unitSourceValueColumn: 'unit',
  },
  conceptTables: [
    { key: 'lab', table: 'lab_concept', idColumn: 'concept_id', nameColumn: 'concept_name', categoryColumn: 'domain' },
    { key: 'drug', table: 'drug_concept', idColumn: 'concept_id', nameColumn: 'concept_name', categoryColumn: 'domain' },
  ],
  eventTables: {
    Lab: { table: 'lab', conceptIdColumn: 'cid', sourceConceptIdColumn: 'scid', patientIdColumn: 'person_id', dateColumn: 'dt', conceptDictionaryKey: 'lab' },
    Drug: { table: 'drug', conceptIdColumn: 'cid', patientIdColumn: 'person_id', dateColumn: 'dt', conceptDictionaryKey: 'drug' },
  },
  genderValues: { male: 'M', female: 'F' },
}
const MAPPING = mappingV1ToV2(MAPPING_V1)
const TABLES = ['drug', 'drug_concept', 'lab', 'lab_concept', 'person', 'unit_stay', 'visit']

// Arithmetic only, no hash(): the same rows on DuckDB-WASM and on the server's
// DuckDB. Every unit type ties on patients (20 each): the top two kept are the
// first by code units, 'Éveil' after 'Zed' — before it in a French collation.
const SETUP = `
CREATE TABLE person AS SELECT i AS person_id, 1930 + (i * 7) % 70 AS year_of_birth,
  CASE i % 5 WHEN 0 THEN 'U' WHEN 1 THEN 'F' WHEN 3 THEN 'F' ELSE 'M' END AS gender
FROM range(1, 61) t(i);
CREATE TABLE visit AS SELECT i AS visit_id, (i * 13) % 60 + 1 AS person_id,
  TIMESTAMP '2019-01-01 00:00:00' + to_days(CAST((i * 37) % 1400 AS INTEGER)) AS vstart,
  TIMESTAMP '2019-01-01 00:00:00' + to_days(CAST((i * 37) % 1400 + i % 6 + 1 AS INTEGER)) AS vend,
  CASE i % 3 WHEN 0 THEN 'ER' WHEN 1 THEN 'Inpatient' ELSE 'Outpatient' END AS vtype
FROM range(1, 151) t(i);
CREATE TABLE unit_stay AS SELECT visit_id * 10 + k AS unit_stay_id, visit_id, person_id, vstart AS ustart, vend AS uend,
  CASE WHEN visit_id % 3 = 0 THEN (CASE k WHEN 1 THEN 'Éveil' ELSE 'Zed' END) WHEN visit_id % 3 = 1 THEN 'Ward' ELSE 'Clinic' END AS unit
FROM visit, range(1, 3) t(k) WHERE k = 1 OR visit_id % 3 = 0;
CREATE TABLE lab_concept AS SELECT i AS concept_id, 'Lab ' || i AS concept_name, 'Measurement' AS domain FROM range(1, 9) t(i);
CREATE TABLE drug_concept AS SELECT i AS concept_id, 'Drug ' || i AS concept_name, 'Drug' AS domain FROM range(1, 6) t(i);
CREATE TABLE lab AS SELECT
  CASE WHEN i % 7 < 4 THEN i % 4 + 1 ELSE i % 8 + 1 END AS cid,
  CASE i % 5 WHEN 0 THEN NULL WHEN 1 THEN (CASE WHEN i % 7 < 4 THEN i % 4 + 1 ELSE i % 8 + 1 END) ELSE (i * 3) % 8 + 1 END AS scid,
  (i * 17) % 60 + 1 AS person_id,
  TIMESTAMP '2019-01-01 00:00:00' + to_days(CAST((i * 29) % 1400 AS INTEGER)) + to_hours(CAST(i % 24 AS INTEGER)) AS dt
FROM range(1, 401) t(i);
CREATE TABLE drug AS SELECT i % 5 + 1 AS cid, (i * 11) % 60 + 1 AS person_id,
  TIMESTAMP '2019-01-01 00:00:00' + to_days(CAST((i * 41) % 1400 AS INTEGER)) + to_hours(CAST(i % 24 AS INTEGER)) AS dt
FROM range(1, 201) t(i)
`

const CATALOG = {
  id: 'twin-catalog',
  dataSourceId: 'twin-db',
  variables: {
    concept: { enabled: true, level: 'concept', scope: 'top', topN: 6, categoryColumn: 'domain' },
    period: { enabled: true, granularity: 'quarter', step: 2 },
    service: { enabled: true, level: 'visit_detail', grouping: 'top', topN: 2, groups: {}, unassigned: 'other' },
    age: { enabled: true, brackets: [30, 60] },
    sex: { enabled: true },
  },
  crossings: [['period', 'age'], ['concept', 'sex'], ['service', 'sex'], ['concept', 'service']],
  counts: { visits: true, unitStays: true },
  anonymization: { threshold: 10, mode: 'replace' },
} as unknown as DataCatalog

// 600 event rows: three patient slices; the six concepts kept, two chunks.
const PLAN_OPTIONS = { sliceRows: 250, conceptChunk: 4 }
const PAUSED_AT = 24
const AT = '2026-11-08T00:00:00.000Z'

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

const prepare = (sql: string) => withClassRelations(sql, MAPPING, TABLES)

interface Ran { sql: string; rows: Record<string, unknown>[] }

/** The browser's run over the tables: every query it sent, and every cache it wrote. */
async function browserRun(resumeFrom: CatalogResultCache | null, pauseAt?: number) {
  const queries: Ran[] = []
  const saved: CatalogResultCache[] = []
  const controller = new AbortController()
  const outcome = await runCatalogComputation({
    catalog: CATALOG,
    mapping: MAPPING,
    tables: TABLES,
    planOptions: PLAN_OPTIONS,
    resumeFrom,
    query: async (sql) => {
      const ran = prepare(sql)
      const rows = conn.query(ran).toArray().map((r) => r.toJSON() as Record<string, unknown>)
      queries.push({ sql: ran, rows })
      return rows
    },
    persist: async (cache) => { saved.push(JSON.parse(JSON.stringify(cache))) },
  }, controller.signal, {
    progress: (computed) => { if (pauseAt != null && computed >= pauseAt) controller.abort() },
  })
  return { outcome, queries, last: saved.at(-1)! }
}

const stable = (c: CatalogResultCache) => ({ ...c, computedAt: AT, durationMs: 0 })

/** Every pair and triple, as the Configuration tab estimates them: the point is to choose. */
function allCrossings(): CatalogVariableId[][] {
  const vars = CATALOG_VARIABLE_ORDER
  return vars.flatMap((a, i) => vars.slice(i + 1).flatMap((b, j) => [[a, b], ...vars.slice(i + j + 2).map((c) => [a, b, c])]))
}

/** The browser's estimate over the tables: every query it sent, and every estimate by key. */
async function browserEstimate() {
  const queries: Ran[] = []
  const byId: Record<string, CrossingEstimate> = {}
  await estimateCrossings({ ...CATALOG, crossings: allCrossings() }, MAPPING, async (sql) => {
    const ran = prepare(sql)
    const rows = conn.query(ran).toArray().map((r) => r.toJSON() as Record<string, unknown>)
    queries.push({ sql: ran, rows })
    return rows
  }, { onEstimate: (id, e) => { byId[id] = e } })
  return { queries, byId }
}

const FILL_SQL = `SELECT 'a /*LINKR_SERVICE_TOP*/ ''b''', "/*LINKR_RANGE:AND:x*/" FROM t -- /*LINKR_RANGE:AND:y*/
WHERE x IN (/*LINKR_SERVICE_TOP*/) AND z/*LINKR_RANGE:AND:t.pid*/ AND w/*LINKR_CONCEPT_IN:0:e.cid*//*LINKR_CONCEPT_IN:1:e.scid*/
/*LINKR_UNKNOWN*/ /* plain */ /*LINKR_RANGE:OR:u.pid*/ FROM u/*LINKR_RANGE:WHERE:u.pid*/`
const FILLS: { sql: string; fill: CatalogFill }[] = [
  { sql: FILL_SQL, fill: {} },
  {
    sql: FILL_SQL,
    fill: { range: { lo: 5 }, topServices: ['ICU', "O'Neil \\ ward", 'Réa'], conceptFilter: [{ dictKey: 'lab', ids: ['1', '22'] }], dictKeys: ['lab', 'drug'] },
  },
  { sql: FILL_SQL, fill: { range: { lo: "a'b", hi: 2.5 }, conceptFilter: [], dictKeys: ['lab'] } },
  { sql: FILL_SQL, fill: { range: { hi: 1e21 }, conceptFilter: [{ dictKey: 'drug', ids: ['3'] }], dictKeys: ['lab', 'drug'] } },
  { sql: 'WHERE /*LINKR_BOUND_PICKS*/', fill: { slices: 2 } },
  { sql: 'WHERE /*LINKR_BOUND_PICKS*/', fill: { slices: 5 } },
]

describe('a catalog run compiled for the server', () => {
  it('stores the cache the browser stores, whole and resumed', async () => {
    const spec = await compileCatalogRunSpec(CATALOG, MAPPING, { label: 'Twin', fresh: true, tables: TABLES, prepare, planOptions: PLAN_OPTIONS })
    const whole = await browserRun(null)
    expect(whole.outcome).toBe('done')
    const cache = stable(whole.last)

    // The fixture reaches the cases it is built for.
    expect(whole.queries[1].sql).toContain('ROW_NUMBER()')
    expect(cache.grandTotal.totalPatients).toBeGreaterThan(0)
    expect(cache.modalities.service).toEqual(['Clinic', 'Ward', '__other__'])
    const crossed = whole.queries.map((q) => q.sql)
    expect(crossed.some((sql) => sql.includes(' AND FALSE'))).toBe(true)
    expect(crossed.some((sql) => sql.includes("IN ('Clinic', 'Ward')"))).toBe(true)
    expect(crossed.some((sql) => sql.includes('patient_id >= ') && sql.includes('patient_id < '))).toBe(true)
    expect(cache.concepts.every((c) => c.patientKey != null)).toBe(true)

    const paused = await browserRun(null, PAUSED_AT)
    expect(paused.outcome).toBe('paused')
    expect(paused.last.completedSteps).toBe(PAUSED_AT)
    expect(paused.last.crossings.length).toBeGreaterThan(0)
    const pausedCache = stable(paused.last)
    const resumed = await browserRun(pausedCache)
    expect(resumed.outcome).toBe('done')
    expect(stable(resumed.last)).toEqual(cache)

    const fills = FILLS.map(({ sql, fill }) => ({ sql, fill, out: fillCatalogSql(sql, fill) }))
    const estimateSpec = await compileCatalogEstimateSpec({ ...CATALOG, crossings: allCrossings() }, MAPPING, { label: 'Twin estimate', known: () => false, prepare })
    const estimated = await browserEstimate()
    expect(estimateSpec!.estimates!.length).toBe(Object.keys(estimated.byId).length)
    expect(estimated.queries.filter((q) => q.sql.includes('published_mass'))).toHaveLength(estimateSpec!.estimates!.length)
    const estimates = Object.fromEntries(estimateSpec!.estimates!.map((e) => [e.key, estimated.byId[e.variables.join('-')]]))
    const estimate = { spec: estimateSpec, queries: estimated.queries, estimates }

    const fixture = { setup: SETUP, tables: TABLES, spec, queries: whole.queries, fills, cache, paused: pausedCache, estimate }
    if (process.env.GOLDEN_UPDATE) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`)
    }
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(fixture)))
  }, 60_000)
})
