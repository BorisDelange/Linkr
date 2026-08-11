import { isServerMode } from '@/lib/api-client'
import { runEtlStream } from '@/lib/api/etl-run-ws'
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

  // Server mode with a managed target: send the script WHOLE over the streaming
  // endpoint. Splitting it here meant one request — and one DuckDB connection —
  // per statement, so a script could not carry `SET VARIABLE` or a temp table
  // from one statement to the next. The server splits it instead and reports
  // each statement, so progress survives without the session being cut up.
  const streamTarget = serverStreamTarget(pipeline)
  if (streamTarget) {
    if (signal?.aborted) throw new RunAbortedError()
    const roles = await serverRoles(pipeline, streamTarget)
    // Last count seen, so completion can report `total/total` — the server
    // announces a statement BEFORE running it, exactly like the loop below.
    let seen = 0
    try {
      const rows = await runEtlStream(streamTarget, sql, roles, mappingData, {
        signal,
        onStatement: (index, total, next) => {
          seen = total
          onProgress?.(index, total, next)
        },
      })
      onProgress?.(seen, seen, undefined)
      return rows
    } catch (err) {
      // A socket closed by Stop is the stop, not a failure.
      if (signal?.aborted) throw new RunAbortedError()
      throw err
    }
  }

  // Statement by statement, so progress is real rather than interpolated: the
  // server splits the batch the same way (db_connect._split_statements), so
  // sending them one at a time changes nothing but the reporting.
  const statements = duckdbEngine.splitSqlStatements(sql)
  const total = statements.length
  const run = statementRunner(dataSourceId)

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
 * The managed target a script should stream against, or undefined when this run
 * does not go through the ETL endpoint (front-only, or no managed target — a
 * plain read-only query then serves).
 */
function serverStreamTarget(pipeline: EtlPipeline | undefined): string | undefined {
  if (!isServerMode()) return undefined
  const targetId = pipeline?.targetDataSourceId
  if (!targetId) return undefined
  const { dataSources } = useDataSourceStore.getState()
  const target = dataSources.find((ds) => ds.id === targetId)
  return isManaged(target) ? targetId : undefined
}

/**
 * The databases attached beside the target, by role. The endpoint runs against
 * the target; every other role is attached beside it.
 */
async function serverRoles(
  pipeline: EtlPipeline | undefined,
  targetId: string,
): Promise<Record<string, string>> {
  const roles: Record<string, string> = {}
  if (pipeline?.sourceDataSourceId && pipeline.sourceDataSourceId !== targetId) {
    roles.source = pipeline.sourceDataSourceId
  }
  const vocabId = await vocabDataSourceId(pipeline)
  if (vocabId && vocabId !== targetId) roles.vocab = vocabId
  return roles
}

/**
 * How a single statement reaches the database on the non-streaming path.
 *
 * Only reached when `serverStreamTarget` declined — front-only, or a server run
 * with no managed target — so a plain query against the picked source is the
 * whole story. The server-side branch that used to live here was unreachable:
 * it re-asked `serverStreamTarget`, the same gate the caller had already passed.
 */
function statementRunner(
  dataSourceId: string,
): (sql: string) => Promise<Record<string, unknown>[]> {
  return (stmt) => duckdbEngine.queryDataSource(dataSourceId, stmt)
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
