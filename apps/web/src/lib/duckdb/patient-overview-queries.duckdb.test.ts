import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import { withClassRelations } from '@/lib/schema-classes/inject'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { NO_SCOPE } from './patient-scope'
import { buildOverviewInventoryQuery, buildOverviewTileDensityQuery, TOTAL_ROW_KEY } from './patient-overview-queries'

// The tile counts, read in one pass of each table, run on a real DuckDB: each
// row counts its concepts, and the total every event of the table.

const MAPPING = mappingV1ToV2({
  presetId: 't',
  presetLabel: { en: 'T' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'mc', patientIdColumn: 'person_id', dateColumn: 'dt', valueColumn: 'v' },
    Drug: { table: 'drug', conceptIdColumn: 'dc', patientIdColumn: 'person_id', dateColumn: 'dt' },
  },
} as unknown as SchemaMappingV1)

// Patient 1: concept 10 every hour, 11 every two, 12 every three, over four
// days; a drug every six hours. Patient 2 alike, never counted.
const SETUP = `
CREATE TABLE person AS SELECT * FROM (VALUES (1), (2)) t(person_id);
CREATE TABLE measurement AS
  SELECT p.person_id, c.mc, TIMESTAMP '2024-01-01' + INTERVAL (h) HOUR AS dt, h * 1.0 AS v
  FROM (VALUES (1), (2)) p(person_id), (VALUES (10, 1), (11, 2), (12, 3)) c(mc, every), range(96) r(h)
  WHERE h % c.every = 0;
CREATE TABLE drug AS
  SELECT p.person_id, 20 AS dc, TIMESTAMP '2024-01-01' + INTERVAL (h) HOUR AS dt
  FROM (VALUES (1), (2)) p(person_id), range(0, 96, 6) r(h)
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

/** Events per row key, summed over the buckets. */
function counted(sql: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of conn.query(withClassRelations(sql, MAPPING)).toArray().map((r) => r.toJSON() as Record<string, unknown>)) {
    const key = String(row.row_key)
    out.set(key, (out.get(key) ?? 0) + Number(row.n))
  }
  return out
}

const ROWS = [
  { key: 'hr', table: 'Measurement', conceptIds: ['10'] },
  { key: 'others', table: 'Measurement', conceptIds: ['11', '12'] },
  { key: 'drugs', table: 'Drug', conceptIds: [] },
]
const DAY = 86_400_000
const FROM = '2024-01-01T00:00:00.000Z'
const TO = '2024-01-05T00:00:00.000Z'

describe('tile counts in one pass of each table', () => {
  it('counts each row its own concepts', () => {
    expect(Object.fromEntries(counted(buildOverviewTileDensityQuery(MAPPING, '1', NO_SCOPE, ROWS, DAY, FROM, TO)!)))
      .toEqual({ hr: 96, others: 48 + 32, drugs: 16 })
  })

  it('counts the same rows, and every event of the tables asked, with the total', () => {
    const sql = buildOverviewTileDensityQuery(MAPPING, '1', NO_SCOPE, ROWS, DAY, FROM, TO, ['Measurement', 'Drug'])!
    expect(sql).toContain('MATERIALIZED')
    expect(Object.fromEntries(counted(sql))).toEqual({ hr: 96, others: 80, drugs: 16, [TOTAL_ROW_KEY]: 96 + 80 + 16 })
  })

  it('counts a table of no visible row in the total', () => {
    const only = buildOverviewTileDensityQuery(MAPPING, '1', NO_SCOPE, [ROWS[0]], DAY, FROM, TO, ['Measurement', 'Drug'])!
    expect(counted(only).get(TOTAL_ROW_KEY)).toBe(96 + 80 + 16)
  })
})

describe('the inventory, grouped before it is named', () => {
  it('counts each concept with its first and last event and its range of values', () => {
    const rows = conn.query(withClassRelations(buildOverviewInventoryQuery(MAPPING, '1', NO_SCOPE)!, MAPPING)).toArray()
      .map((r) => r.toJSON() as Record<string, unknown>)
    const of = (id: string) => rows.find((r) => r.concept_id === id)!
    expect(of('10')).toMatchObject({ table_label: 'Measurement', event_count: 96, value_min: 0, value_max: 95 })
    expect(of('12')).toMatchObject({ event_count: 32, value_min: 0, value_max: 93 })
    expect(of('20')).toMatchObject({ table_label: 'Drug', event_count: 16, value_min: null, value_max: null })
  })
})
