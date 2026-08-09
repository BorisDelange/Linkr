import { isServerMode } from '@/lib/api-client'
import { runEtlOnServer } from '@/lib/api/data-sources'
import * as duckdbEngine from '@/lib/duckdb/engine'
import type { DatabaseConnectionConfig, DataSource, EtlPipeline } from '@/types'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'

function isManaged(ds: DataSource | undefined): boolean {
  return !!(ds && (ds.connectionConfig as DatabaseConnectionConfig)?.managed)
}

/**
 * Run one ETL statement batch.
 *
 * Front-only: every database is a schema of the same browser DuckDB, so a plain
 * query already reaches all of them.
 *
 * Server: a normal query is sent to a single data source, which cannot serve a
 * script that reads one database and writes another. When the PIPELINE has a
 * managed (server-owned, writable) target, go through the ETL endpoint, which
 * attaches that target writable and the other roles read-only in one
 * connection. Anything else keeps the plain read-only query path.
 *
 * `dataSourceId` is only where an unqualified statement is aimed — the picker
 * next to Run. It deliberately does not decide the endpoint: a script pointed
 * at the source still needs `target.` to resolve.
 */
export interface RunOptions {
  /** Reports statements finished / total, so a long script shows progress
   *  instead of an opaque "running". */
  onProgress?: (done: number, total: number) => void
  /** Stops between statements when the user hits Stop. A statement already in
   *  flight runs to completion — DuckDB has no mid-query cancellation here. */
  signal?: AbortSignal
}

export async function runPipelineSql(
  pipeline: EtlPipeline | undefined,
  dataSourceId: string,
  sql: string,
  options: RunOptions = {},
): Promise<Record<string, unknown>[]> {
  const { onProgress, signal } = options

  // Statement by statement, so progress is real rather than interpolated: the
  // server splits the batch the same way (db_connect._split_statements), so
  // sending them one at a time changes nothing but the reporting.
  const statements = duckdbEngine.splitSqlStatements(sql)
  const total = statements.length
  const run = await statementRunner(pipeline, dataSourceId)

  let last: Record<string, unknown>[] = []
  for (const [i, stmt] of statements.entries()) {
    if (signal?.aborted) break
    last = await run(stmt)
    onProgress?.(i + 1, total)
  }
  return last
}

/**
 * Pick how a single statement reaches the database, once per script rather than
 * once per statement — the role lookup can hit the store and the network.
 */
async function statementRunner(
  pipeline: EtlPipeline | undefined,
  dataSourceId: string,
): Promise<(sql: string) => Promise<Record<string, unknown>[]>> {
  if (!isServerMode()) {
    return (stmt) => duckdbEngine.queryDataSource(dataSourceId, stmt)
  }

  const { dataSources } = useDataSourceStore.getState()
  const targetId = pipeline?.targetDataSourceId
  const target = dataSources.find((ds) => ds.id === targetId)
  if (!targetId || !isManaged(target)) {
    return (stmt) => duckdbEngine.queryDataSource(dataSourceId, stmt)
  }

  // The endpoint runs against the target; every other role is attached beside
  // it, including the picked database when that is not the target itself.
  const roles: Record<string, string> = {}
  if (pipeline?.sourceDataSourceId && pipeline.sourceDataSourceId !== targetId) {
    roles.source = pipeline.sourceDataSourceId
  }
  const vocabId = await vocabDataSourceId(pipeline)
  if (vocabId && vocabId !== targetId) roles.vocab = vocabId

  return (stmt) => runEtlOnServer(targetId, stmt, roles)
}

/**
 * ATHENA reference of the pipeline's mapping project, if any.
 *
 * The projects are loaded on demand: only the Vocabulary and Pipeline tabs
 * populate that store, so running a script straight from the Scripts tab would
 * otherwise find it empty and silently drop the `vocab` role.
 */
export async function vocabDataSourceId(
  pipeline: EtlPipeline | undefined,
): Promise<string | undefined> {
  if (!pipeline?.mappingProjectId) return undefined
  const store = useConceptMappingStore.getState()
  if (!store.mappingProjectsLoaded) await store.loadMappingProjects()
  const { mappingProjects } = useConceptMappingStore.getState()
  return mappingProjects.find((p) => p.id === pipeline.mappingProjectId)?.vocabularyDataSourceId
}
