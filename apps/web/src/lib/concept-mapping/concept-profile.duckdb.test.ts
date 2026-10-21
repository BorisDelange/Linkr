import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { beforeAll, describe, expect, it } from 'vitest'

import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import {
  DEFAULT_PROFILE_OPTIONS,
  buildConceptProfile,
  buildConceptProfiles,
  resolveProfileSource,
  type ProfileOptions,
} from './concept-profile'

// The batched profiles must give, concept by concept, the JSON of the
// per-concept queries — run here on a real DuckDB (the WASM build the app ships,
// in its Node flavour), over rows built to hit the edge cases: concepts sharing
// rows through source_concept_id, one without values, one under the k-anonymity
// threshold (6: five patients, never a source concept), one absent, outliers, empty strings, missing dates.

const OMOP_V1: SchemaMappingV1 = {
  presetId: 'omop-5.4',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitDetailTable: {
    table: 'visit_detail',
    idColumn: 'visit_detail_id',
    visitIdColumn: 'visit_occurrence_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'vds',
    endDateColumn: 'vde',
    unitColumn: 'care_site_id',
    unitNameTable: 'care_site',
    unitNameIdColumn: 'care_site_id',
    unitNameColumn: 'care_site_name',
  },
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
const OMOP = mappingV1ToV2(OMOP_V1)

// h(n): a deterministic pseudo-random draw per row, in [0, 1000).
const SETUP = `
CREATE TABLE m AS
WITH r AS (
  SELECT i,
    hash(i * 7 + 1) % 1000 AS h1, hash(i * 7 + 2) % 1000 AS h2, hash(i * 7 + 3) % 1000 AS h3,
    hash(i * 7 + 4) % 1000 AS h4, hash(i * 7 + 5) % 1000 AS h5, hash(i * 7 + 6) % 1000 AS h6,
    hash(i * 7 + 7) % 1000 AS h7
  FROM range(20000) t(i)
), c AS (
  SELECT *, CASE WHEN h1 < 100 THEN NULL WHEN h1 < 180 THEN 99 ELSE CAST(h1 % 7 + 1 AS INTEGER) END AS cid FROM r
)
SELECT
  cid AS concept_id,
  CASE h2 % 4 WHEN 0 THEN NULL WHEN 1 THEN cid WHEN 2 THEN [1, 2, 3, 4, 5, 7][CAST(h2 % 6 + 1 AS INTEGER)] ELSE 99 END AS source_concept_id,
  CAST(CASE WHEN cid = 6 THEN h3 % 5 + 1 ELSE h3 % 300 + 1 END AS INTEGER) AS patient_id,
  CASE WHEN cid = 3 OR h4 < 200 THEN NULL
       ELSE ROUND(((h5 + h6 + h7) / 15.0) * (CASE WHEN h4 > 990 THEN 10 ELSE 1 END), 3) END AS value_number,
  CASE h6 % 8 WHEN 0 THEN NULL WHEN 1 THEN '' WHEN 2 THEN ' ' WHEN 3 THEN 'A' WHEN 4 THEN 'B'
       WHEN 5 THEN 'C' WHEN 6 THEN repeat('long', 20) ELSE CAST(h5 % 50 AS VARCHAR) END AS value_string,
  CASE h7 % 4 WHEN 0 THEN NULL WHEN 1 THEN 'mg' WHEN 2 THEN 'g' ELSE '' END AS unit,
  CASE WHEN h7 < 50 THEN NULL
       ELSE TIMESTAMP '2010-01-01 10:00:00' + to_days(CAST(h5 * 4 + h6 % 4 AS INTEGER)) + to_hours(CAST(h3 % 14 AS INTEGER)) END AS start_datetime
FROM c;
CREATE VIEW linkr_event_measurements AS SELECT * FROM m;
CREATE TABLE linkr_visit_detail AS
  SELECT p AS patient_id,
         TIMESTAMP '2010-01-01' + to_days(CAST(i * 700 AS INTEGER)) AS start_datetime,
         TIMESTAMP '2010-01-01' + to_days(CAST(i * 700 + 600 AS INTEGER)) AS end_datetime,
         'W' || (p % 4)::VARCHAR || i::VARCHAR AS unit_name
  FROM range(1, 301) t(p), range(0, 8) r(i);
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

const query = async (sql: string) =>
  conn.query(sql).toArray().map((row) => row.toJSON() as Record<string, unknown>)

const source = () => {
  const s = resolveProfileSource(OMOP, 'concept')
  if (!s) throw new Error('no profile source')
  return s
}

const CONCEPTS = [1, 2, 3, 4, 5, 6, 7, 8, 99].map((conceptId) => ({ conceptId, conceptName: `c${conceptId}` }))

describe('batched profiles on DuckDB', () => {
  it.each(['iqr', 'percentile', 'none'] as const)('give the per-concept JSON (outliers: %s)', async (outlierMethod) => {
    const options: ProfileOptions = { ...DEFAULT_PROFILE_OPTIONS, outlierMethod, minCategoryCount: 5 }
    const batched = await buildConceptProfiles(OMOP, source(), CONCEPTS, options, query)
    for (const concept of CONCEPTS) {
      const one = await buildConceptProfile(OMOP, source(), concept, options, query)
      expect(JSON.stringify(batched.get(concept.conceptId)), `concept ${concept.conceptId}`).toBe(JSON.stringify(one))
    }
    // The fixture reaches the cases it is built for.
    expect(batched.get(6)?.json).toBeNull()
    expect(batched.get(8)).toMatchObject({ rowsCount: 0 })
    expect(batched.get(1)?.json?.numeric_data).toBeTruthy()
  }, 60_000)

  it('gives the same JSON when the records cannot be counted first', async () => {
    const options: ProfileOptions = { ...DEFAULT_PROFILE_OPTIONS, minCategoryCount: 5 }
    const refusingCounts = async (sql: string) => {
      if (sql.includes('AS concept_id, COUNT(*) AS n FROM scope')) throw new Error('count refused')
      return query(sql)
    }
    // Absent ids too, so the unsized concepts span more than one batch.
    const concepts = [...CONCEPTS, ...[10, 11, 12, 13, 14].map((conceptId) => ({ conceptId }))]
    const counted = await buildConceptProfiles(OMOP, source(), concepts, options, query)
    const unsized = await buildConceptProfiles(OMOP, source(), concepts, options, refusingCounts)
    for (const { conceptId } of concepts) {
      expect(JSON.stringify(unsized.get(conceptId)), `concept ${conceptId}`).toBe(JSON.stringify(counted.get(conceptId)))
    }
  }, 60_000)
})
