import { isServerMode } from '@/lib/api-client'
import { runEtlOnServer } from '@/lib/api/data-sources'
import * as duckdbEngine from '@/lib/duckdb/engine'
import type { DatabaseConnectionConfig, DataSource, EtlPipeline } from '@/types'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { MAPPING_REF_PREFIX, usedMappingRefs } from '@/lib/duckdb/mapping-source'

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
   *  instead of an opaque "running". `next` is the statement about to run, so the
   *  counter can name what it is waiting on. */
  onProgress?: (done: number, total: number, next?: string) => void
  /** Stops between statements when the user hits Stop. A statement already in
   *  flight runs to completion — DuckDB has no mid-query cancellation here. */
  signal?: AbortSignal
  /** `mapping.<name>` exports the script reads, as CSV text, keyed by export
   *  name. Supplied per run: the rows live outside the versioned script. */
  mappingData?: Record<string, string>
}

/** Thrown when a run is stopped, so callers can tell it from a completed one. */
export class RunAbortedError extends Error {
  constructor() {
    super('Run stopped')
    this.name = 'RunAbortedError'
  }
}

export async function runPipelineSql(
  pipeline: EtlPipeline | undefined,
  dataSourceId: string,
  sql: string,
  options: RunOptions = {},
): Promise<Record<string, unknown>[]> {
  const { onProgress, signal, mappingData = {} } = options

  // Statement by statement, so progress is real rather than interpolated: the
  // server splits the batch the same way (db_connect._split_statements), so
  // sending them one at a time changes nothing but the reporting.
  const statements = duckdbEngine.splitSqlStatements(sql)
  const total = statements.length
  const run = await statementRunner(pipeline, dataSourceId, mappingData)

  // Front-only resolves the `mapping.` references itself: DuckDB-WASM reads the
  // CSV out of its virtual filesystem, registered under the reference's own
  // name so the SQL needs no rewriting. Server mode sends the text with each
  // statement instead, and resolves it there (db_connect._resolve_mapping_refs).
  const release = isServerMode()
    ? async () => {}
    : await duckdbEngine.registerVirtualCsv(virtualCsvFiles(sql, mappingData))

  try {
    return await runStatements(statements, total, run, onProgress, signal)
  } finally {
    await release()
  }
}

/**
 * The exports a script actually reads, keyed by the literal it uses, so
 * `read_csv('mapping.source_to_concept_map')` resolves with no rewriting.
 */
function virtualCsvFiles(
  sql: string,
  mappingData: Record<string, string>,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of usedMappingRefs(sql)) {
    const csv = mappingData[name]
    // A missing export is left unregistered on purpose: DuckDB then fails naming
    // it, rather than reading a stale or empty file.
    if (csv !== undefined) files[`${MAPPING_REF_PREFIX}${name}`] = csv
  }
  return files
}

async function runStatements(
  statements: string[],
  total: number,
  run: (sql: string) => Promise<Record<string, unknown>[]>,
  onProgress: RunOptions['onProgress'],
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>[]> {
  let last: Record<string, unknown>[] = []
  for (const [i, stmt] of statements.entries()) {
    // Raise rather than return: a stopped run has no result, and returning the
    // rows of the statements that did run made the caller post them as the
    // script's output — a half-executed script looking like a successful one.
    if (signal?.aborted) throw new RunAbortedError()
    // One report per statement, before it runs: `done` and `next` then always
    // describe the SAME statement — the one being waited on. Reporting again
    // afterwards made them disagree (done=i+1 with the text of statement i+1,
    // which the display reads as statement i+2), so the tooltip appeared to lag
    // the counter by one.
    onProgress?.(i, total, stmt)
    last = await run(stmt)
  }
  // Completion, with no statement pending.
  onProgress?.(total, total, undefined)
  // The last statement may have finished after Stop was pressed; it still counts
  // as stopped, since the user asked for no further output.
  if (signal?.aborted) throw new RunAbortedError()
  return last
}

/**
 * Pick how a single statement reaches the database, once per script rather than
 * once per statement — the role lookup can hit the store and the network.
 */
async function statementRunner(
  pipeline: EtlPipeline | undefined,
  dataSourceId: string,
  mappingData: Record<string, string>,
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

  return (stmt) => runEtlOnServer(targetId, stmt, roles, mappingData)
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
