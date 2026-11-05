import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { describe, it } from 'vitest'

import { withClassRelations } from '@/lib/schema-classes/inject'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { NO_SCOPE } from './patient-scope'
import { toMs } from './value-coercion'
import {
  buildOverviewDensityQuery,
  buildOverviewEventsQuery,
  buildOverviewInventoryQuery,
  buildOverviewTileDensityQuery,
} from './patient-overview-queries'

// The Data overview's queries on a dense patient, timed on DuckDB-WASM (the
// browser's engine) under a memory cap. Off unless OVERVIEW_BENCH names the
// dense dataset (npm run test-data -- mimic-iv-demo-dense):
//   OVERVIEW_BENCH=<testData.dir>/mimic-iv-demo-dense OVERVIEW_BENCH_MEMORY=512MB npx vitest run overview.perf

const DIR = process.env.OVERVIEW_BENCH
const MEMORY = process.env.OVERVIEW_BENCH_MEMORY ?? '1GB'
const PATIENTS = (process.env.OVERVIEW_BENCH_PATIENTS ?? '990000001,990000002,990000003,990000004').split(',')
const TABLES = ['person', 'visit_occurrence', 'visit_detail', 'measurement', 'drug_exposure', 'observation', 'concept',
  'condition_occurrence', 'procedure_occurrence', 'device_exposure', 'death', 'care_site', 'note', 'specimen']

describe.runIf(!!DIR)('data overview on a dense patient (DuckDB-WASM)', () => {
  it('times each query', { timeout: 3_600_000 }, async () => {
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
    const conn = db.connect()
    conn.query(`SET memory_limit = '${MEMORY}'`)
    for (const t of TABLES) conn.query(`CREATE VIEW ${t} AS SELECT * FROM read_parquet('${DIR}/${t}.parquet')`)
    const mapping = mappingV1ToV2(JSON.parse(readFileSync(join(DIR!, '..', 'mimic-iv-demo-omop', 'mapping.json'), 'utf8')) as SchemaMappingV1)
    const time = (label: string, sql: string | null) => {
      if (!sql) return []
      const t0 = performance.now()
      try {
        const rows = conn.query(withClassRelations(sql, mapping)).toArray().map((r) => r.toJSON() as Record<string, unknown>)
        console.log(`  ${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms  ${rows.length} rows`)
        return rows
      } catch (e) {
        console.log(`  ${label.padEnd(28)} FAILED after ${(performance.now() - t0).toFixed(0)} ms: ${String(e).slice(0, 160)}`)
        return []
      }
    }

    for (const patient of PATIENTS) {
      console.log(`patient ${patient} (memory_limit ${MEMORY})`)
      const inv = time('inventory', buildOverviewInventoryQuery(mapping, patient, NO_SCOPE))
      if (inv.length === 0) continue
      const lo = Math.min(...inv.map((r) => toMs(r.first_event) ?? Infinity))
      const hi = Math.max(...inv.map((r) => toMs(r.last_event) ?? -Infinity))
      const from = new Date(lo).toISOString()
      const to = new Date(hi + 1).toISOString()
      const byTable = new Map<string, string[]>()
      for (const r of inv) byTable.set(String(r.table_label), [...(byTable.get(String(r.table_label)) ?? []), String(r.concept_id)])
      const bands = [...byTable].map(([table]) => ({ key: table, table, conceptIds: [] as string[] }))
      // What the widget asks first: the rows on screen (the busiest 30), at
      // about a pixel a bucket over the whole record.
      const visible = inv.slice().sort((a, b) => Number(b.event_count) - Number(a.event_count)).slice(0, 30)
        .map((r) => ({ key: `${r.table_label}|${r.concept_id}`, table: String(r.table_label), conceptIds: [String(r.concept_id)] }))
      const bucketMs = 2 ** Math.ceil(Math.log2((hi - lo) / 1200))
      time('strip alone (fallback)', buildOverviewDensityQuery(mapping, patient, NO_SCOPE, from, to, 240, bands))
      time('tiles, 30 rows, year', buildOverviewTileDensityQuery(mapping, patient, NO_SCOPE, visible, bucketMs, from, to))
      time('tiles + strip, one read', buildOverviewTileDensityQuery(mapping, patient, NO_SCOPE, visible, bucketMs, from, to, [...byTable.keys()]))
      const rows = visible
      const day = new Date(lo + 86_400_000).toISOString()
      time('tiles, all rows, one day', buildOverviewTileDensityQuery(mapping, patient, NO_SCOPE, rows, 2 ** 16, from, day))
      const top = inv.slice().sort((a, b) => Number(b.event_count) - Number(a.event_count))[0]
      time('events, busiest row, a day', buildOverviewEventsQuery(mapping, patient, NO_SCOPE, String(top.table_label), [String(top.concept_id)], from, day, 4000))
    }
  })
})
