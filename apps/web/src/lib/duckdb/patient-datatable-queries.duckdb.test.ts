import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import { withClassRelations } from '@/lib/schema-classes/inject'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { NO_SCOPE } from './patient-scope'
import { buildDataTableBoundsQuery, buildDataTableDensityQuery, buildDataTableQuery, type DataTableAggregate } from './patient-datatable-queries'

// The Data table's cells, computed by a real DuckDB: each column holds the
// aggregate of its own events and says how many there were.

const MAPPING = mappingV1ToV2({
  presetId: 't',
  presetLabel: { en: 'T' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurement: {
      table: 'measurement', conceptIdColumn: 'mc', sourceConceptIdColumn: 'msc', patientIdColumn: 'person_id',
      dateColumn: 'dt', valueColumn: 'v', valueUnitColumn: 'u',
    },
  },
} as unknown as SchemaMappingV1)

// Patient 1, heart rate (10) every hour of 2024-01-01: value = the hour. A
// locally coded one (source 10) at 23:30. Patient 2 alike, never counted.
const SETUP = `
CREATE TABLE person AS SELECT * FROM (VALUES (1), (2)) t(person_id);
CREATE TABLE concept AS SELECT * FROM (VALUES (10, 'Heart rate')) t(concept_id, concept_name);
CREATE TABLE measurement AS
  SELECT p.person_id, 10 AS mc, NULL::INTEGER AS msc, TIMESTAMP '2024-01-01' + INTERVAL (h) HOUR AS dt, h * 1.0 AS v, 'bpm' AS u
  FROM (VALUES (1), (2)) p(person_id), range(24) r(h)
  UNION ALL SELECT 1, 0, 10, TIMESTAMP '2024-01-01 23:30:00', 100.0, 'bpm'
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

const run = (sql: string) =>
  conn.query(withClassRelations(sql, MAPPING)).toArray().map((r) => r.toJSON() as Record<string, unknown>)

/** The cells of a day cut in four columns of six hours, by column. */
function cells(aggregate: DataTableAggregate) {
  const sql = buildDataTableQuery(MAPPING, [10], '1', NO_SCOPE, {
    from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z', columns: 4, aggregate,
  })!
  return run(sql).sort((a, b) => Number(a.col) - Number(b.col)).map((r) => ({ col: r.col, value: r.value, n: r.n }))
}

describe('the Data table on DuckDB', () => {
  it('averages each column over its own events, and counts them', () => {
    expect(cells('mean')).toEqual([
      { col: 0, value: 2.5, n: 6 },
      { col: 1, value: 8.5, n: 6 },
      { col: 2, value: 14.5, n: 6 },
      // Hours 18 to 23 and the source-coded 100 at 23:30.
      { col: 3, value: (18 + 19 + 20 + 21 + 22 + 23 + 100) / 7, n: 7 },
    ])
  })

  it('takes the last and the first value of a column by time', () => {
    expect(cells('last').map((c) => c.value)).toEqual([5, 11, 17, 100])
    expect(cells('first').map((c) => c.value)).toEqual([0, 6, 12, 18])
    expect(cells('count').map((c) => c.value)).toEqual([6, 6, 6, 7])
    expect(cells('median')[0]).toMatchObject({ value: 2.5, n: 6 })
  })

  it('opens on the patient’s first and last event', () => {
    const [b] = run(buildDataTableBoundsQuery(MAPPING, [10], '1', NO_SCOPE)!)
    expect(new Date(Number(b.first_event)).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(new Date(Number(b.last_event)).toISOString()).toBe('2024-01-01T23:30:00.000Z')
  })

  it('counts the events of each slice of the record for the density strip', () => {
    const rows = run(buildDataTableDensityQuery(MAPPING, [10], '1', NO_SCOPE, {
      from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z', buckets: 2,
    })!).sort((a, b) => Number(a.col) - Number(b.col))
    expect(rows.map((r) => [Number(r.col), Number(r.n)])).toEqual([[0, 12], [1, 13]])
  })

  it('comments each concept id with what it is', () => {
    const sql = buildDataTableBoundsQuery(MAPPING, [10], '1', NO_SCOPE, { label: () => 'LOINC · Heart rate' })!
    expect(sql).toContain('10 -- LOINC · Heart rate')
  })

  it('searches a table for the concepts the count found there only', () => {
    const held = new Map([['linkr_event_measurement', new Set<number>()]])
    expect(buildDataTableQuery(MAPPING, [10], '1', NO_SCOPE, {
      from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z', columns: 4, aggregate: 'mean', held,
    })).toBeNull()
  })
})
