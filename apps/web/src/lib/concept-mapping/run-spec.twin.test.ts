/**
 * A concept run compiled here (`buildRunSpec`) and run by the server
 * (apps/api tests/test_concept_run_twin.py) stores the profiles the browser's
 * own run stores over the same data. This writes, beside the spec, the tables'
 * SQL and the browser's profiles; the server's test builds the tables as
 * Parquet, runs the spec and compares.
 *
 * To regenerate after an intentional change:
 *   GOLDEN_UPDATE=1 npx vitest run src/lib/concept-mapping/run-spec.twin.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { DataType } from 'apache-arrow'
import { beforeAll, describe, expect, it } from 'vitest'

import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { exactOptions, type StoredProfile } from '@/lib/concept-profiles/profile-store'
import { DEFAULT_PROFILE_OPTIONS, resolveProfileSource } from './concept-profile'
import { DEFAULT_EXTRACTION_SORT } from './source-extraction'
import { startRun, watchRun, type RunSnapshot } from './extraction-runner'
import { buildRunSpec } from './run-spec'
import { countSpecOf } from '@/features/projects/warehouse/concepts/concept-count-runner'
import {
  CONCEPT_COUNT_VERSION,
  conceptCountSignature,
  planConceptCountUnits,
} from '@/features/projects/warehouse/concepts/concept-count-plan'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/concept-runs/run-spec.json')

const MAPPING_V1: SchemaMappingV1 = {
  presetId: 'omop-5.4',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurements: {
      table: 'measurement',
      conceptIdColumn: 'mc',
      sourceConceptIdColumn: 'msc',
      valueColumn: 'v',
      valueStringColumn: 'vs',
      valueUnitColumn: 'u',
      patientIdColumn: 'person_id',
      dateColumn: 'dt',
    },
  },
}
const MAPPING = mappingV1ToV2(MAPPING_V1)
const TABLES = ['concept', 'measurement', 'person']

// Arithmetic only, no hash(): the same rows on DuckDB-WASM and on the server's DuckDB.
const SETUP = `
CREATE TABLE concept AS SELECT i AS concept_id, 'Concept ' || i AS concept_name FROM range(1, 13) t(i);
CREATE TABLE person AS SELECT i AS person_id FROM range(1, 121) t(i);
CREATE TABLE measurement AS
SELECT
  CASE WHEN i % 17 = 0 THEN 0 ELSE CAST((i * 7) % 10 + 1 AS INTEGER) END AS mc,
  CASE i % 5 WHEN 0 THEN NULL WHEN 1 THEN 11 ELSE CAST((i * 7) % 10 + 1 AS INTEGER) END AS msc,
  CASE WHEN i % 9 = 3 THEN NULL ELSE ROUND(((i * 37) % 1000) / 13.0, 2) END AS v,
  CASE i % 6 WHEN 0 THEN NULL WHEN 1 THEN 'low' WHEN 2 THEN 'high' ELSE CAST((i * 7) % 12 AS VARCHAR) END AS vs,
  -- One unit leading each concept: a tie would let either engine pick its own.
  CASE WHEN i % 5 < 3 THEN 'mg' WHEN i % 5 = 3 THEN 'g' ELSE NULL END AS u,
  CAST(CASE WHEN (i * 7) % 10 + 1 = 8 THEN i % 4 + 1 ELSE (i * 13) % 120 + 1 END AS INTEGER) AS person_id,
  TIMESTAMP '2015-01-01 08:00:00' + to_days(CAST((i * 11) % 2000 AS INTEGER)) + to_hours(CAST(i % 24 AS INTEGER)) AS dt
FROM range(1, 6001) t(i)
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

const prepare = async (sql: string) => withClassRelations(sql, MAPPING, TABLES)
// Shaped as the server hands rows over: a date as its ISO day.
const query = async (sql: string) => {
  const table = conn.query(await prepare(sql))
  const dates = table.schema.fields.filter((f) => DataType.isDate(f.type)).map((f) => f.name)
  return table.toArray().map((row) => {
    const out = row.toJSON() as Record<string, unknown>
    for (const c of dates) if (typeof out[c] === 'number') out[c] = new Date(out[c] as number).toISOString().slice(0, 10)
    return out
  })
}

/** The browser's run over the same data, into a store in memory. */
async function browserProfiles(fingerprint: string, options: typeof DEFAULT_PROFILE_OPTIONS): Promise<StoredProfile[]> {
  const stored = new Map<string, StoredProfile>()
  const projectId = 'twin'
  const ended = new Promise<RunSnapshot>((resolve) => {
    let started = false
    watchRun(projectId, (s) => {
      if (s.running) started = true
      else if (started) resolve(s)
    })
  })
  startRun({
    projectId,
    mapping: MAPPING,
    sources: [resolveProfileSource(MAPPING, 'concept')!],
    options,
    sort: DEFAULT_EXTRACTION_SORT,
    onlyWithRecords: true,
    resumeFrom: null,
    query,
    queryAll: query,
    persist: async () => {},
    persistError: async () => {},
    store: async () => ({
      fingerprint,
      read: async (dictKey, ids) => new Map(ids.flatMap((id) => {
        const p = stored.get(`${dictKey}:${id}`)
        return p ? [[id, p] as const] : []
      })),
      write: async (profiles) => { for (const p of profiles) stored.set(`${p.dictKey}:${p.conceptId}`, p) },
    }),
  })
  const end = await ended
  if (end.error) throw new Error(end.error)
  return [...stored.values()].sort((a, b) => a.conceptId - b.conceptId)
}

const withoutTime = (p: StoredProfile) => ({ ...p, computedAt: '' })

describe('a run compiled for the server', () => {
  it('stores the profiles the browser stores', async () => {
    const fingerprint = 'twin-fingerprint'
    const options = exactOptions({ ...DEFAULT_PROFILE_OPTIONS, minCategoryCount: 3 })
    const spec = await buildRunSpec({
      label: 'Twin',
      mapping: MAPPING,
      sources: [resolveProfileSource(MAPPING, 'concept')!],
      options,
      sort: DEFAULT_EXTRACTION_SORT,
      onlyWithRecords: true,
      fingerprint,
      prepare,
    })
    const expected = (await browserProfiles(fingerprint, options)).map(withoutTime)
    // The fixture reaches the cases it is built for: a concept withheld under
    // the patient threshold, one with no record, several with values.
    expect(expected.length).toBeGreaterThan(5)
    // The counts first, as the Concepts tab asks: one slice, every unit to count.
    const units = planConceptCountUnits(MAPPING, [{}])
    const runId = 'twin-counts'
    const countsManifest = {
      runId,
      version: CONCEPT_COUNT_VERSION,
      signature: conceptCountSignature(units, MAPPING, TABLES),
      slices: [{}],
      units: units.map(({ key, step }) => ({ key, step })),
      startedAt: '2026-11-08T00:00:00.000Z',
    }
    const counts = countSpecOf(MAPPING, TABLES, runId, units, new Set(), ['records', 'patients'])
    const fixture = { setup: SETUP, spec, expected, countsManifest, counts }
    if (process.env.GOLDEN_UPDATE) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
    }
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(fixture)))
  }, 60_000)
})
