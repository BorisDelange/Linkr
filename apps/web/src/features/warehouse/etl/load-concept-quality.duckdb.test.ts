import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import type { PlanResults } from '@/lib/server-runs/query-plan'
import { assembleConceptQuality, conceptQualityPlan, MAPPINGS_KEY } from './load-concept-quality'

// The Quality check's concept comparison, as a plan of independent queries —
// what a server run runs and the page assembles — on a real DuckDB.

const SETUP = `
CREATE TABLE concept AS SELECT * FROM (VALUES
  (2000000001, 'LOCAL', 'HR', 'Heart rate'),
  (2000000002, 'LOCAL', 'SBP', 'Systolic'),
  (3027018, 'LOINC', '8867-4', 'Heart rate'),
  (3004249, 'LOINC', '8480-6', 'Systolic')) t(concept_id, vocabulary_id, concept_code, concept_name);
CREATE TABLE concept_relationship AS SELECT * FROM (VALUES
  (2000000001, 3027018, 'Maps to'),
  (2000000002, 3004249, 'Maps to')) t(concept_id_1, concept_id_2, relationship_id);
CREATE TABLE measurement AS SELECT
  i % 10 AS person_id,
  CASE WHEN i % 3 = 0 THEN 3004249 ELSE 3027018 END AS measurement_concept_id,
  CASE WHEN i % 3 = 0 THEN 2000000002 ELSE 2000000001 END AS measurement_source_concept_id
FROM range(30) r(i);
CREATE TABLE observation AS SELECT 1 AS person_id, 0 AS observation_concept_id, 2000000001 AS observation_source_concept_id;
CREATE TABLE source_to_concept_map AS SELECT * FROM (VALUES
  ('LOCAL', 'X', 'Other', 2000000009, 3027018, 'LOINC')) t(source_vocabulary_id, source_code, source_code_description, source_concept_id, target_concept_id, target_vocabulary_id)
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
  db.open({ query: { castBigIntToDouble: true } })
  conn = db.connect()
  for (const stmt of SETUP.split(';').map((s) => s.trim()).filter(Boolean)) conn.query(stmt)
}, 60_000)

const TABLES = ['concept', 'concept_relationship', 'measurement', 'observation', 'source_to_concept_map']

function run(tables: readonly string[] | null): PlanResults {
  const plan = conceptQualityPlan(tables, 'Quality', {})
  return new Map(plan.items.map((item) => [
    item.key, conn.query(item.sql).toArray().map((row) => row.toJSON() as Record<string, unknown>),
  ]))
}

describe('the concept comparison, as a plan', () => {
  it('reads the C/CR mappings and counts each concept on both sides', () => {
    const rows = assembleConceptQuality(run(TABLES))
    expect(rows.map((r) => [r.sourceCode, r.sourceRows, r.targetRows])).toEqual([
      // 20 measurements + the observation that mapped to nothing; 20 arrived as standard.
      ['HR', 21, 20],
      ['SBP', 10, 10],
    ])
    // Patients add up over the tables, as records do: 10 in measurement, 1 in observation.
    expect(rows[0]).toMatchObject({ sourcePatients: 11, targetPatients: 10 })
  })

  it('leaves out the tables the target lacks', () => {
    const keys = conceptQualityPlan(TABLES, 'Quality', {}).items.map((i) => i.key)
    expect(keys).toEqual([MAPPINGS_KEY, 'src_measurement', 'std_measurement', 'src_observation', 'std_observation'])
  })

  it('falls back on source_to_concept_map when C/CR holds no mapping', () => {
    conn.query('CREATE TABLE cr_kept AS SELECT * FROM concept_relationship')
    conn.query('DELETE FROM concept_relationship')
    try {
      expect(assembleConceptQuality(run(TABLES)).map((r) => r.sourceCode)).toEqual(['X'])
      // Without the table, no fallback query: just none.
      expect(assembleConceptQuality(run(TABLES.filter((t) => t !== 'source_to_concept_map')))).toEqual([])
    } finally {
      conn.query('INSERT INTO concept_relationship SELECT * FROM cr_kept')
      conn.query('DROP TABLE cr_kept')
    }
  })

  it('fails when one of its queries failed, rather than count it as nothing', () => {
    const results = run(TABLES)
    results.set('std_measurement', new Error('cut by a reload'))
    expect(() => assembleConceptQuality(results)).toThrow('cut by a reload')
  })
})
