// Type-only import: erased at build so the DuckDB-WASM glue JS is NOT bundled
// unconditionally. The runtime module is loaded on demand via `loadDuckDBModule()`
// (dynamic import), so a server-mode build that never boots WASM ships without it.
import type * as duckdb from '@duckdb/duckdb-wasm'
import { Type as ArrowType } from 'apache-arrow'
import { isServerMode } from '@/lib/api-client'
import { fetchDataSourceSchema, queryDataSourceOnServer } from '@/lib/api/data-sources'
import { queryFileSourceOnServer } from '@/lib/api/mapping-projects'
import type { DataSource, DatabaseConnectionConfig, StoredFile, StoredFileHandle, DataSourceStats, SchemaMapping, FileColumnMapping } from '@/types'

const resetHooks = new Set<() => void>()
/** Register a callback invoked from `resetDuckDB()` so dependent modules can drop cached registrations. */
export function registerResetHook(fn: () => void): void {
  resetHooks.add(fn)
}

// DuckDB WASM assets are served from public/duckdb/ to avoid Vite @fs blocking.
// After `npm install`, run: cp node_modules/@duckdb/duckdb-wasm/dist/{duckdb-mvp.wasm,duckdb-eh.wasm,duckdb-browser-mvp.worker.js,duckdb-browser-eh.worker.js} public/duckdb/
// BASE_URL prefix keeps these resolvable under a sub-path deployment. Resolved
// lazily against globalThis.location so importing this module stays safe in
// Node (unit tests import it transitively).
const duckdbAsset = (f: string) =>
  new URL(`${import.meta.env.BASE_URL ?? '/'}duckdb/${f}`, globalThis.location?.href ?? 'http://localhost/').href
const duckdb_mvp_wasm = duckdbAsset('duckdb-mvp.wasm')
const duckdb_mvp_worker = duckdbAsset('duckdb-browser-mvp.worker.js')
const duckdb_eh_wasm = duckdbAsset('duckdb-eh.wasm')
const duckdb_eh_worker = duckdbAsset('duckdb-browser-eh.worker.js')

// Split a SQL script into statements. Now backed by the shared tokenizer so the
// splitter and the role-prefix rewriter agree on what is a comment / literal /
// dollar-quote (a `;` inside any of those must not split a statement).
import { splitSqlStatements } from './sql-tokenizer'
import { shouldGuardMount, isAttachedCatalog } from './mount-guard'
export { splitSqlStatements }

let _db: duckdb.AsyncDuckDB | null = null
let _initPromise: Promise<duckdb.AsyncDuckDB> | null = null
let _worker: Worker | null = null

let _modulePromise: Promise<typeof import('@duckdb/duckdb-wasm')> | null = null
/** Load the DuckDB-WASM runtime module on demand (front-only). Cached so the
 *  dynamic chunk is fetched at most once. */
function loadDuckDBModule(): Promise<typeof import('@duckdb/duckdb-wasm')> {
  if (!_modulePromise) _modulePromise = import('@duckdb/duckdb-wasm')
  return _modulePromise
}

/** Try to instantiate DuckDB with a specific bundle (worker URL + WASM URL). */
async function tryInstantiate(
  workerUrl: string,
  wasmUrl: string,
  label: string,
): Promise<duckdb.AsyncDuckDB> {
  const mod = await loadDuckDBModule()
  const worker = new Worker(workerUrl)
  _worker = worker

  worker.addEventListener('error', (e) => {
    console.error(`[DuckDB:${label}] Worker error:`, e.message)
  })

  // WARNING level by default — DuckDB-WASM otherwise logs every INSERT/SELECT to
  // the browser console, which on a 300k-row populateTable adds up to thousands
  // of console.log calls and slows DevTools (and the main thread) to a crawl.
  const logger = new mod.ConsoleLogger(mod.LogLevel.WARNING)
  const db = new mod.AsyncDuckDB(logger, worker)

  // Wrap instantiate with a timeout — worker may crash silently
  await Promise.race([
    db.instantiate(wasmUrl),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`DuckDB ${label} instantiate timed out`)), 10_000),
    ),
  ])

  // Disable extension autoloading — DuckDB-WASM bundles Parquet support
  // natively, but the autoloader still tries to fetch from the CDN and fails.
  // Explicitly load parquet to ensure read_parquet() is available before any
  // query runs (avoids "not in catalog" errors on first Parquet mount).
  const conn = await db.connect()
  try {
    await conn.query("SET autoinstall_known_extensions = false")
    await conn.query("SET autoload_known_extensions = false")
    await conn.query("LOAD parquet")
  } finally {
    await conn.close()
  }

  return db
}

/** Lazily initialize the DuckDB-WASM singleton. */
export async function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (_db) return _db
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    // Try EH bundle first (faster), fall back to MVP if it crashes
    try {
      const db = await tryInstantiate(duckdb_eh_worker, duckdb_eh_wasm, 'eh')
      _db = db
      return db
    } catch (ehErr) {
      console.warn('[DuckDB] EH bundle failed, falling back to MVP:', ehErr)
      // Clean up failed worker
      if (_worker) { try { _worker.terminate() } catch { /* ignore */ } }
      _worker = null
    }

    try {
      const db = await tryInstantiate(duckdb_mvp_worker, duckdb_mvp_wasm, 'mvp')
      _db = db
      return db
    } catch (mvpErr) {
      _initPromise = null
      throw new Error(`DuckDB initialization failed: ${mvpErr instanceof Error ? mvpErr.message : mvpErr}`)
    }
  })()

  return _initPromise
}

/**
 * Reset the DuckDB singleton, terminating the current worker.
 * Call this after a timeout to allow re-initialization on next getDuckDB().
 */
export function resetDuckDB(): void {
  if (_worker) {
    try { _worker.terminate() } catch { /* ignore */ }
    _worker = null
  }
  _db = null
  _initPromise = null
  attachedSources.clear()
  for (const fn of resetHooks) {
    try { fn() } catch { /* ignore */ }
  }
}

// --- Schema naming ---

/**
 * Generate a DuckDB-safe alias (slug) from a human-readable name.
 * E.g. "MIMIC-IV Demo (raw)" → "mimic_iv_demo_raw"
 */
export function generateAlias(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'db'
}

/**
 * Ensure alias is unique among existing aliases by appending _2, _3, etc.
 */
export function ensureUniqueAlias(alias: string, existingAliases: string[]): string {
  if (!existingAliases.includes(alias)) return alias
  let i = 2
  while (existingAliases.includes(`${alias}_${i}`)) i++
  return `${alias}_${i}`
}

/** Maps dataSourceId → alias for schema naming. Populated by mount calls. */
const aliasMap = new Map<string, string>()

/** Register (or update) the alias for a data source so schemaName() uses it. */
export function registerAlias(dataSourceId: string, alias: string): void {
  aliasMap.set(dataSourceId, alias)
}

/** Get the DuckDB schema name for a data source (ds_<alias> or ds_<sanitized_id>). */
export function schemaName(dataSourceId: string): string {
  const alias = aliasMap.get(dataSourceId)
  const base = alias ?? dataSourceId
  return 'ds_' + base.replace(/[^a-zA-Z0-9]/g, '_')
}

/** Track which data sources are ATTACHed (vs schema-based). */
const attachedSources = new Set<string>()

/**
 * Mounts a source if it is not in DuckDB yet, so a query never has to assume
 * someone else got there first.
 *
 * The store owns mounting (it holds the rows, the files and the in-flight
 * promises) but imports this module, so it injects its `ensureMounted` here
 * rather than being imported back. Left unset — in tests, or before the store
 * is created — queries run as they always did.
 */
let mountGuard: ((dataSourceId: string) => Promise<void>) | undefined

export function setMountGuard(guard: (dataSourceId: string) => Promise<void>): void {
  mountGuard = guard
}

// --- Mount / unmount ---

/**
 * Mount a data source into DuckDB.
 * Registers files and creates views/ATTACHes the database.
 */
export async function mountDataSource(
  dataSource: DataSource,
  files: StoredFile[],
): Promise<void> {
  if (dataSource.alias) registerAlias(dataSource.id, dataSource.alias)
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSource.id)
  const config = dataSource.connectionConfig as DatabaseConnectionConfig

  try {
    // Clean up any leftover schema from a previous failed mount
    await safeDropSchema(conn, dataSource.id)

    if (config.fileIds && config.fileIds.length > 0) {
      // Multi-file folder mode -> ATTACH a catalog + views per table
      const knownTables = dataSource.schemaMapping?.knownTables
      await mountFileFolder(db, conn, schema, files, knownTables)
      attachedSources.add(dataSource.id)
    } else if (files.length > 0) {
      // Single file -> ATTACH (DuckDB or SQLite)
      const file = files[0]
      await db.registerFileBuffer(file.fileName, new Uint8Array(file.data))
      await conn.query(`ATTACH '${file.fileName}' AS "${schema}" (READ_ONLY)`)
      attachedSources.add(dataSource.id)
    }
  } finally {
    await conn.close()
  }
}

/** Unmount a data source (drop schema or DETACH). */
export async function unmountDataSource(dataSourceId: string): Promise<void> {
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    if (attachedSources.has(dataSourceId)) {
      await conn.query(`DETACH "${schema}"`)
      attachedSources.delete(dataSourceId)
    } else {
      await conn.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  } catch {
    // Ignore errors if already unmounted
  } finally {
    await conn.close()
  }
}

/**
 * Create an empty schema from DDL statements.
 * Used to create empty databases from schema presets (e.g., empty OMOP for ETL target).
 */
export async function mountEmptyFromDDL(
  dataSourceId: string,
  ddl: string,
  alias?: string,
): Promise<void> {
  if (alias) registerAlias(dataSourceId, alias)
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    // Clean up any leftover schema
    await safeDropSchema(conn, dataSourceId)

    // ATTACH rather than CREATE SCHEMA, so the source is a catalog here as it is
    // everywhere else. A DDL that declares its own schemas (`CREATE SCHEMA hosp;
    // CREATE TABLE hosp.patients …`) then lands inside the source instead of
    // spilling into `memory`, and unqualified statements still land in its main.
    await conn.query(`ATTACH ':memory:' AS "${schema}"`)
    attachedSources.add(dataSourceId)
    await conn.query(`SET search_path TO "${schema}".main`)

    // Execute DDL statement by statement, skipping unsupported ALTER TABLE constraints
    const statements = ddl.split(';').map((s) => s.trim()).filter(Boolean)
    for (const stmt of statements) {
      // Skip ALTER TABLE ... ADD CONSTRAINT (FK not supported in DuckDB-WASM schemas)
      if (/^\s*ALTER\s+TABLE\s/i.test(stmt)) continue
      try {
        await conn.query(stmt)
      } catch (e) {
        console.warn('[mountEmptyFromDDL] Skipping failed statement:', stmt.slice(0, 80), e)
      }
    }

    // Reset search path
    await conn.query(`SET search_path TO main`)
  } catch (err) {
    // Reset search path even on error; the original error is what matters, so
    // a failure to reset here must not mask it.
    try { await conn.query(`SET search_path TO main`) } catch { /* ignore */ }
    throw err
  } finally {
    await conn.close()
  }
}

// --- Query ---

/**
 * `SET search_path` for an ATTACHed source: its `main`, then every module schema
 * it carries, so a bare table name resolves whether or not the folder had module
 * directories. Sorted, so which schema wins a name present in two of them never
 * depends on mount order.
 *
 * The whole list is ONE single-quoted literal: `SET search_path` takes a scalar,
 * and a bare comma-separated list is a parser error. Schema names come from the
 * catalog and are identifiers, so they cannot carry a quote to escape.
 */
async function catalogSearchPath(
  conn: duckdb.AsyncDuckDBConnection,
  catalog: string,
): Promise<string> {
  try {
    const rows = await conn.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE catalog_name = '${catalog}' AND schema_name <> 'main'
       ORDER BY schema_name`,
    )
    const schemas = rows.toArray().map((r: Record<string, unknown>) => String(r.schema_name))
    const path = [`${catalog}.main`, ...schemas.map((s) => `${catalog}.${s}`)].join(',')
    return `'${path}'`
  } catch {
    // Older mount or no catalog yet — the plain form is what always worked.
    return `'${catalog}.main'`
  }
}

/** Discover table names in a mounted data source. */
export async function discoverTables(dataSourceId: string): Promise<string[]> {
  // Server mode: the source's own catalog (not DuckDB's information_schema,
  // which through the ATTACH would show internal views) — via the schema endpoint.
  if (isServerMode()) {
    const tables = await fetchDataSourceSchema(dataSourceId)
    return tables.map((t) => t.name)
  }
  // Same wait as queryDataSource: listing the tables of a source that is not
  // mounted yet returns none, and callers read that as a real answer. That is
  // how Concepts, reached directly, decided the database had no concept table
  // and said so instead of loading.
  if (shouldGuardMount(dataSourceId, !!mountGuard)) {
    await mountGuard!(dataSourceId)
  }
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    // A source can be either schema-based (tables under a schema named `<schema>`)
    // OR ATTACHed as its own catalog. The `attached` flag can flip mid-session
    // (queryDataSource's fallback promotes a source to attached), which is why a
    // second scan saw zero tables while the first saw them. Match BOTH layouts so
    // discovery is stable regardless of the flag.
    //
    // A module directory becomes a schema inside the catalog, so a table there is
    // reported as `hosp.patients` — the same qualified name the server reports,
    // and the one `quoteTableRef` knows how to quote back.
    const result = await conn.query(
      `SELECT DISTINCT table_schema, table_name FROM information_schema.tables
       WHERE table_schema = '${schema}' OR table_catalog = '${schema}'
       ORDER BY table_schema, table_name`,
    )
    return result.toArray().map((row: Record<string, unknown>) => {
      const s = String(row.table_schema)
      const t = String(row.table_name)
      return s === schema || s === 'main' ? t : `${s}.${t}`
    })
  } finally {
    await conn.close()
  }
}

// --- Full schema introspection ---

export interface IntrospectedColumn {
  name: string
  type: string
  nullable: boolean
}

export interface IntrospectedTable {
  name: string
  columns: IntrospectedColumn[]
}

/**
 * Introspect the full database schema (all tables + columns)
 * via information_schema.columns. Uses queryDataSource() so
 * search_path is set correctly for both schema-based and ATTACHed sources.
 */
export async function discoverFullSchema(dataSourceId: string): Promise<IntrospectedTable[]> {
  // Server mode: use the native-catalog introspection endpoint (see discoverTables).
  if (isServerMode()) {
    return fetchDataSourceSchema(dataSourceId)
  }
  const rows = await queryDataSource(
    dataSourceId,
    `SELECT table_name, column_name, data_type, is_nullable, ordinal_position
     FROM information_schema.columns
     ORDER BY table_name, ordinal_position`,
  )

  const tableMap = new Map<string, IntrospectedColumn[]>()
  for (const row of rows) {
    const tableName = String(row.table_name)
    if (!tableMap.has(tableName)) tableMap.set(tableName, [])
    tableMap.get(tableName)!.push({
      name: String(row.column_name),
      type: String(row.data_type),
      nullable: String(row.is_nullable) === 'YES',
    })
  }

  return Array.from(tableMap.entries()).map(([name, columns]) => ({ name, columns }))
}

/** Compute stats for a data source using its schema mapping. */
export async function computeStats(
  dataSourceId: string,
  schemaMapping?: SchemaMapping,
  countRows = true,
): Promise<DataSourceStats> {
  // Server mode: table count comes from the introspected schema (free — no scan).
  // Row counts (patient/visit COUNT) are deliberately skipped unless countRows
  // is set, so connecting to a billion-row database runs zero COUNT(*) queries;
  // the user triggers those explicitly via "Load statistics".
  if (isServerMode()) {
    const tables = await fetchDataSourceSchema(dataSourceId)
    const stats: DataSourceStats = { tableCount: tables.length }
    if (countRows && schemaMapping?.patientTable) {
      stats.patientCount = await serverCount(
        dataSourceId, schemaMapping.patientTable.table, schemaMapping.patientTable.schema,
      )
      if (schemaMapping.visitTable) {
        stats.visitCount = await serverCount(
          dataSourceId, schemaMapping.visitTable.table, schemaMapping.visitTable.schema,
        )
      }
    }
    return stats
  }
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    // Table count
    const tablesResult = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = '${schema}'`,
    )
    const tableCount = Number(tablesResult.toArray()[0]?.cnt ?? 0)

    if (schemaMapping?.patientTable) {
      const patientCount = await safeCount(
        conn, schema, schemaMapping.patientTable.table, schemaMapping.patientTable.schema,
      )
      const visitCount = schemaMapping.visitTable
        ? await safeCount(
            conn, schema, schemaMapping.visitTable.table, schemaMapping.visitTable.schema,
          )
        : 0
      return { patientCount, visitCount, tableCount }
    }

    return { tableCount }
  } finally {
    await conn.close()
  }
}

/**
 * Make CSV text readable by `read_csv('<name>')` for the duration of a run.
 *
 * Front-only has no filesystem, so a mapping export cannot be a file on disk;
 * DuckDB-WASM's virtual file system takes the text directly. Returns a disposer
 * — the registration is per-run, since the rows change whenever the mapping
 * project does.
 */
export async function registerVirtualCsv(
  files: Record<string, string>,
): Promise<() => Promise<void>> {
  const names = Object.keys(files)
  if (names.length === 0) return async () => {}
  const db = await getDuckDB()
  for (const name of names) await db.registerFileText(name, files[name])
  return async () => {
    for (const name of names) {
      // A failed drop must not mask the run's own error.
      try { await db.dropFile(name) } catch { /* already gone */ }
    }
  }
}

/** Run an arbitrary SQL query against a data source schema. */
export async function queryDataSource(
  dataSourceId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  // Server mode: the tables live on the server (external DB or server-held
  // files), so the query runs there — the browser never loads the raw data.
  // Front-only mode keeps the in-browser DuckDB-WASM path below.
  if (isServerMode()) {
    // A mapping project's file source (`filesrc_<projectId>`) is not a real data
    // source row — its CSV is queried by the mapping-projects endpoint instead.
    if (dataSourceId.startsWith('filesrc_')) {
      return queryFileSourceOnServer(dataSourceId.slice('filesrc_'.length), sql)
    }
    return queryDataSourceOnServer(dataSourceId, sql)
  }
  // Wait for the source to be in DuckDB before naming its schema. Callers used
  // to have to do this themselves, and the ones that forgot raced the mount on
  // a fresh load: the schema was not there yet (or was being dropped and
  // rebuilt), so the page failed with "No catalog + schema named ds_…" or
  // "Table ... does not exist" and stayed empty until a reload.
  if (shouldGuardMount(dataSourceId, !!mountGuard)) {
    await mountGuard!(dataSourceId)
  }
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    // Try schema-based path first, fall back to catalog.main for ATTACHed databases
    if (attachedSources.has(dataSourceId)) {
      await conn.query(`SET search_path TO ${await catalogSearchPath(conn, schema)}`)
    } else {
      try {
        await conn.query(`SET search_path TO "${schema}"`)
      } catch {
        // Schema might be an ATTACHed catalog — retry with catalog.main
        await conn.query(`SET search_path TO ${await catalogSearchPath(conn, schema)}`)
        attachedSources.add(dataSourceId)
      }
    }
    // Split multi-statement SQL by semicolons and execute each statement
    // sequentially. DuckDB-WASM doesn't reliably handle multi-statement
    // queries when views reference other views created in the same batch
    // (causes Binder Error with type mismatches like INTEGER vs BIGINT).
    // Use a parser that respects quoted strings so semicolons inside
    // string literals (e.g. 'Sodium Chloride 23.4%;30ML V') are not
    // treated as statement separators.
    const statements = splitSqlStatements(sql)

    let result: Awaited<ReturnType<typeof conn.query>> | null = null
    for (const stmt of statements) {
      result = await conn.query(stmt)
    }

    if (!result) return []

    // Build set of DATE/TIMESTAMP columns from Arrow schema so we can
    // convert their BigInt epoch values to proper ISO date strings.
    const dateColumns = new Set<string>()
    const timestampColumns = new Set<string>()
    for (const field of result.schema.fields) {
      const typeId = field.type.typeId
      if (typeId === ArrowType.Date) dateColumns.add(field.name)
      else if (typeId === ArrowType.Timestamp) timestampColumns.add(field.name)
    }
    return (result.toArray() as Record<string, unknown>[]).map((row) =>
      coerceRow(row, dateColumns, timestampColumns),
    )
  } finally {
    await conn.close()
  }
}

/**
 * Like queryDataSource but returns ALL rows, not just the server's per-request
 * page. Server-mode responses are capped (MAX_QUERY_ROWS) to protect the API, so
 * a `SELECT *` over a large source silently truncates — which is exactly what
 * broke ID assignment (183k concepts → only ~10k assigned). Here we page through
 * with LIMIT/OFFSET wrapped around the base SQL until a short page ends it. In
 * WASM mode there is no cap, so we do a single query.
 *
 * `baseSql` must be a single SELECT with no trailing semicolon and no LIMIT of
 * its own (it gets wrapped as `SELECT * FROM (<baseSql>) LIMIT n OFFSET k`).
 */
// Must stay ≤ the server's MAX_QUERY_ROWS (db_connect.py). The server silently
// truncates any response to that many rows; if a page asked for MORE, a full
// (truncated) page would look short and stop the loop early — dropping data. So
// the page size is exactly the server cap: a full page means "there may be more".
const SERVER_PAGE_ROWS = 10_000

export async function queryDataSourceAll(
  dataSourceId: string,
  baseSql: string,
  pageSize = SERVER_PAGE_ROWS,
): Promise<Record<string, unknown>[]> {
  if (!isServerMode()) return queryDataSource(dataSourceId, baseSql)

  // Never exceed the server cap (see note above) — a larger page can't be
  // distinguished from a truncated one, which would silently lose rows.
  const step = Math.min(pageSize, SERVER_PAGE_ROWS)
  const all: Record<string, unknown>[] = []
  for (let offset = 0; ; offset += step) {
    // ORDER BY ALL is REQUIRED, not cosmetic: LIMIT/OFFSET over a query with no
    // total order (e.g. the deduped `source_concepts` view, whose QUALIFY
    // row_number has no stable global order) returns INCONSISTENT rows across
    // pages — DuckDB may reorder between offsets, so boundary rows get skipped
    // (and others duplicated). That silently dropped ~1400 of 17k source concepts
    // during id assignment. A deterministic order over all columns makes the
    // page windows stable and the union complete.
    const page = await queryDataSource(
      dataSourceId,
      `SELECT * FROM (${baseSql}) AS _src ORDER BY ALL LIMIT ${step} OFFSET ${offset}`,
    )
    all.push(...page)
    if (page.length < step) break
  }
  return all
}

// --- Helpers ---

/** Convert BigInt values in a row to Number, and DATE/TIMESTAMP BigInts to ISO strings. */
function coerceRow(
  row: Record<string, unknown>,
  dateColumns: Set<string>,
  timestampColumns: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key in row) {
    const v = row[key]
    if (dateColumns.has(key) && (typeof v === 'bigint' || typeof v === 'number')) {
      // Arrow DATE is encoded as milliseconds since epoch
      out[key] = new Date(Number(v)).toISOString().slice(0, 10)
    } else if (timestampColumns.has(key) && (typeof v === 'bigint' || typeof v === 'number')) {
      // Arrow TIMESTAMP from DuckDB-WASM is returned as milliseconds since epoch
      out[key] = new Date(Number(v)).toISOString()
    } else if (typeof v === 'bigint') {
      out[key] = Number(v)
    } else {
      out[key] = v
    }
  }
  return out
}

/** Drop a schema (or DETACH) if it already exists, ignoring errors. */
async function safeDropSchema(
  conn: duckdb.AsyncDuckDBConnection,
  dataSourceId: string,
): Promise<void> {
  const schema = schemaName(dataSourceId)
  // Ask DuckDB what is actually there rather than trusting `attachedSources`.
  // That set is module memory: it is filled only once a mount succeeds, so a
  // mount that failed after its ATTACH, or a store reset (which clears the
  // store's own mounted set, not this one), leaves a database attached that we
  // no longer remember. We then took the DROP SCHEMA branch, which does not
  // detach anything, and the next ATTACH died with "database with name
  // ds_… already exists".
  // Same catalog lookup catalogSearchPath already relies on: a row here means a
  // database is attached under that name, whatever this module remembers.
  // Schema names are `ds_` + alphanumerics, so they cannot carry a quote.
  let catalogRows: number | undefined
  try {
    const rows = await conn.query(
      `SELECT 1 FROM information_schema.schemata WHERE catalog_name = '${schema}'`,
    )
    catalogRows = rows.toArray().length
  } catch {
    // Leave undefined — isAttachedCatalog falls back to what we remember.
  }

  if (isAttachedCatalog({ remembered: attachedSources.has(dataSourceId), catalogRows })) {
    try {
      await conn.query(`DETACH "${schema}"`)
    } catch {
      // Already detached or not found
    }
    attachedSources.delete(dataSourceId)
  } else {
    // Schema-based (Parquet views) — DROP SCHEMA
    try {
      await conn.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } catch {
      // Ignore — schema may not exist yet
    }
  }
}

/** COUNT(*) on a mapped table via the server query path (server mode). */
async function serverCount(dataSourceId: string, table: string, schema?: string): Promise<number> {
  // Same mapped-schema rule as safeCount: qualify only when the mapping names a
  // schema, so a multi-module source counts its rows and a single-schema one
  // still resolves through the search path.
  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`
  const qualified = schema ? `${quote(schema)}.${quote(table)}` : quote(table)
  try {
    const rows = await queryDataSource(dataSourceId, `SELECT COUNT(*) AS cnt FROM ${qualified}`)
    return Number(rows[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

/**
 * COUNT(*) on a mapped table, 0 if it cannot be read.
 *
 * `schema` is the mapping's own optional field, not a prefix parsed out of
 * `table`: a source published as several modules (MIMIC-IV's `hosp`/`icu`) mounts
 * its views under that schema, so qualifying the table with the catalog alone
 * looked for `<catalog>.main.patients` and counted 0. When the mapping omits it,
 * the name stays unqualified on purpose — that is what lets the search path find
 * it, the way every preset written before schemas existed still works.
 */
async function safeCount(
  conn: duckdb.AsyncDuckDBConnection,
  catalog: string,
  table: string,
  schema?: string,
): Promise<number> {
  const qualified = schema
    ? `"${catalog}"."${schema}"."${table}"`
    : `"${catalog}"."${table}"`
  try {
    const r = await conn.query(`SELECT COUNT(*) as cnt FROM ${qualified}`)
    return Number(r.toArray()[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

// --- Parquet folder support ---

/**
 * A file name that carries no table identity of its own — the Hive/Spark
 * convention where the table is the *directory* and files are numbered shards
 * (`admissions/part-00000-xxx.parquet`, `chunk_3.parquet`, `0001.parquet`).
 */
function isShardFileName(baseName: string): boolean {
  // `part-00000`, `part-00000-<uuid>-c000`, `chunk_3`, `data.1`, `0001`. The
  // digits after the separator are what distinguish a shard from a real table
  // that merely starts with one of these words (`data_quality`, `file_registry`).
  return /^(part|chunk|data|file)[-_.]\d+([-_.]\w+)*$/.test(baseName) || /^\d+$/.test(baseName)
}

/**
 * Extract a table name from a file path.
 * If knownTables is provided, matches against that set.
 * Otherwise uses file/directory name heuristic.
 */
export function extractTableName(filePath: string, knownTables?: string[]): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const knownSet = knownTables ? new Set(knownTables) : null
  const baseName = parts[parts.length - 1].replace(/\.[^.]+$/, '').toLowerCase()

  if (knownSet) {
    // Walk segments from right to left, find the first known table name
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i].replace(/\.[^.]+$/, '').toLowerCase()
      if (knownSet.has(seg)) return seg
    }
  }

  // The file name is the table name (`admissions.parquet`), unless it is a
  // numbered shard — only then does the parent directory carry the identity.
  if (parts.length >= 2 && isShardFileName(baseName)) {
    return parts[parts.length - 2].toLowerCase()
  }
  return baseName
}

/**
 * Table name plus the schema its folder stands for.
 *
 * A warehouse is often published one directory per module — MIMIC-IV ships
 * `hosp/` and `icu/`, eHOP eleven Oracle schemas — and flattening that loses
 * real information: eHOP 4.4 has a de-identified `EDBM_EDS.EHOP_PATIENT` and a
 * nominative `EDBM_ZPAT.EHOP_PATIENT`, so one of the two becomes unreachable.
 *
 * `root` is the folder the user picked (`commonDirPrefix`), and it is NOT a
 * schema — otherwise every flat import would land in a schema named after the
 * download folder. Only a directory *below* it is one, which leaves a flat
 * selection with no schema at all, exactly as before.
 */
export function extractTableRef(
  filePath: string,
  root: string,
  knownTables?: string[],
): { schema: string | undefined; table: string } {
  const table = extractTableName(filePath, knownTables)
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const rootParts = root.replace(/\\/g, '/').split('/').filter(Boolean)
  // Only strip the root when it really is this path's prefix: a caller may pass
  // the prefix of a different selection, and half-matching it would read a
  // table directory as a schema.
  const below = rootParts.every((p, i) => parts[i]?.toLowerCase() === p.toLowerCase())
    ? parts.slice(rootParts.length)
    : parts
  // `below` is [schema?, (table dir)?, file]. Drop the file, then the directory
  // that already gave its name to the table (the shard layout) — whatever single
  // segment is left is the schema.
  const dirs = below.slice(0, -1)
  const remaining = dirs.length > 0 && dirs[dirs.length - 1].toLowerCase() === table
    ? dirs.slice(0, -1)
    : dirs
  const schema = remaining.length > 0
    ? remaining[remaining.length - 1].toLowerCase()
    : undefined
  return { schema, table }
}

/**
 * A grouping key that survives a Map: `table`, or `schema.table`.
 *
 * Two modules may hold the same table name (eHOP's de-identified and nominative
 * EHOP_PATIENT), so the schema has to be part of the key or one silently
 * swallows the other's files.
 */
function tableKey(ref: { schema: string | undefined; table: string }): string {
  return ref.schema ? `${ref.schema}.${ref.table}` : ref.table
}

/** Split a `tableKey` back into its parts. */
function splitTableKey(key: string): { schema?: string; table: string } {
  const i = key.indexOf('.')
  return i < 0 ? { table: key } : { schema: key.slice(0, i), table: key.slice(i + 1) }
}

/**
 * `CREATE VIEW` for one grouped table inside the source's catalog, creating the
 * module schema on the way. `main` is the home of a folder that carried no
 * module directories — the shape every source imported before schemas existed.
 */
async function createSourceView(
  conn: duckdb.AsyncDuckDBConnection,
  catalog: string,
  key: string,
  reader: string,
): Promise<void> {
  const { schema, table } = splitTableKey(key)
  const target = schema ?? 'main'
  if (schema) await conn.query(`CREATE SCHEMA IF NOT EXISTS "${catalog}"."${schema}"`)
  await conn.query(
    `CREATE OR REPLACE VIEW "${catalog}"."${target}"."${table}" AS SELECT * FROM ${reader}`,
  )
}

/**
 * Deepest directory shared by every path — what a folder picker selected.
 * Returns '' when the paths are bare file names (no directory component).
 */
export function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return ''
  const dirs = paths.map((p) => p.replace(/\\/g, '/').split('/').slice(0, -1))
  let shared = dirs[0]
  for (const d of dirs.slice(1)) {
    let i = 0
    while (i < shared.length && i < d.length && shared[i] === d[i]) i++
    shared = shared.slice(0, i)
    if (shared.length === 0) break
  }
  return shared.join('/')
}

/** Group StoredFile entries by table name. */
export function groupFilesByTable(files: StoredFile[], knownTables?: string[]): Map<string, StoredFile[]> {
  const root = commonDirPrefix(files.map((f) => f.fileName))
  const map = new Map<string, StoredFile[]>()
  for (const file of files) {
    const key = tableKey(extractTableRef(file.fileName, root, knownTables))
    const group = map.get(key) ?? []
    group.push(file)
    map.set(key, group)
  }
  return map
}

/** Detect the DuckDB reader function for a file based on its extension. */
function fileReaderFn(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.parquet') || lower.endsWith('.pq')) return 'read_parquet'
  return 'read_csv_auto'
}

/** Build a DuckDB reader expression for one or more files (auto-detects CSV vs Parquet). */
function buildReaderExpr(fileNames: string[]): string {
  const fn = fileReaderFn(fileNames[0])
  if (fileNames.length === 1) return `${fn}('${fileNames[0]}')`
  const list = fileNames.map((n) => `'${n}'`).join(', ')
  return `${fn}([${list}])`
}

/**
 * Mount a folder of data files (Parquet or CSV) as views in the source's catalog.
 *
 * ATTACHed rather than created as a schema, so a source is a *catalog* here as it
 * is on the server, and its module directories can be schemas inside it. A plain
 * schema would use up the only level available and leave `source.hosp.patients`
 * with nowhere to put `hosp`.
 */
async function mountFileFolder(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  schema: string,
  files: StoredFile[],
  knownTables?: string[],
): Promise<void> {
  await conn.query(`ATTACH ':memory:' AS "${schema}"`)
  const byTable = groupFilesByTable(files, knownTables)

  for (const [key, tableFiles] of byTable) {
    // Register all files for this table
    const registeredNames: string[] = []
    for (const f of tableFiles) {
      await db.registerFileBuffer(f.fileName, new Uint8Array(f.data))
      registeredNames.push(f.fileName)
    }

    await createSourceView(conn, schema, key, buildReaderExpr(registeredNames))
  }
}

// --- File System Access API (zero-copy) ---

/**
 * Request read permissions for all stored file handles.
 * Returns true if all handles are granted, false otherwise.
 */
export async function requestHandlePermissions(
  handles: StoredFileHandle[],
): Promise<boolean> {
  for (const h of handles) {
    const status = await h.handle.queryPermission({ mode: 'read' })
    if (status === 'granted') continue
    if (status === 'prompt') {
      const result = await h.handle.requestPermission({ mode: 'read' })
      if (result !== 'granted') return false
    } else {
      return false
    }
  }
  return true
}

/** Group StoredFileHandle entries by the (schema, table) their path stands for. */
function groupHandlesByTable(
  handles: StoredFileHandle[],
  knownTables?: string[],
): Map<string, StoredFileHandle[]> {
  const root = commonDirPrefix(handles.map((h) => h.fileName))
  const map = new Map<string, StoredFileHandle[]>()
  for (const h of handles) {
    const key = tableKey(extractTableRef(h.fileName, root, knownTables))
    const group = map.get(key) ?? []
    group.push(h)
    map.set(key, group)
  }
  return map
}

/**
 * Mount a data source using File System Access API handles (no IDB copy).
 *
 * Uses handle.getFile() to obtain a File object, then registers it with
 * BROWSER_FILEREADER protocol. This avoids copying multi-GB files into
 * IndexedDB while remaining compatible with real-filesystem handles
 * from showDirectoryPicker() (BROWSER_FSACCESS only works with OPFS).
 */
export async function mountDataSourceFromHandles(
  dataSource: DataSource,
  handles: StoredFileHandle[],
): Promise<void> {
  if (dataSource.alias) registerAlias(dataSource.id, dataSource.alias)
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSource.id)
  const config = dataSource.connectionConfig as DatabaseConnectionConfig

  try {
    // Clean up any leftover schema from a previous failed mount
    await safeDropSchema(conn, dataSource.id)

    if (config.fileIds && config.fileIds.length > 0) {
      // Multi-file folder mode -> ATTACH a catalog, as the IDB path does
      await conn.query(`ATTACH ':memory:' AS "${schema}"`)
      attachedSources.add(dataSource.id)
      const knownTables = dataSource.schemaMapping?.knownTables
      const byTable = groupHandlesByTable(handles, knownTables)

      for (const [key, tableHandles] of byTable) {
        const registeredNames: string[] = []
        for (const h of tableHandles) {
          const file = await h.handle.getFile()
          await db.registerFileHandle(
            h.fileName,
            file,
            (await loadDuckDBModule()).DuckDBDataProtocol.BROWSER_FILEREADER,
            true,
          )
          registeredNames.push(h.fileName)
        }

        await createSourceView(conn, schema, key, buildReaderExpr(registeredNames))
      }
    } else if (handles.length > 0) {
      // Single file -> ATTACH
      const h = handles[0]
      const file = await h.handle.getFile()
      await db.registerFileHandle(
        h.fileName,
        file,
        (await loadDuckDBModule()).DuckDBDataProtocol.BROWSER_FILEREADER,
        true,
      )
      await conn.query(`ATTACH '${h.fileName}' AS "${schema}" (READ_ONLY)`)
      attachedSources.add(dataSource.id)
    }
  } finally {
    await conn.close()
  }
}

// --- File source → DuckDB in-memory table ---

/** Track mounted file source projects so we skip re-mounting. */
const mountedFileSources = new Set<string>()

/** In-flight mount promises to prevent concurrent mounts for the same project. */
const mountingPromises = new Map<string, Promise<void>>()

/** Check if a file source project is already mounted in DuckDB. */
export function isFileSourceMounted(projectId: string): boolean {
  return mountedFileSources.has(projectId)
}

/** Get the virtual data source ID used for a file source project. */
export function fileSourceDataSourceId(projectId: string): string {
  return `filesrc_${projectId}`
}

/**
 * Load file source data into a DuckDB in-memory view so that SQL queries
 * (filter, sort, paginate, count, distinct) can run against it instead of
 * iterating a JS array.
 *
 * Creates schema `ds_filesrc_<projectId>` with a single view `source_concepts`.
 *
 * Two loading paths:
 * - **rawFileBuffer** (fast): registers the raw CSV in DuckDB and creates a
 *   view with `read_csv_auto`, renaming columns per the column mapping.
 * - **rows** (legacy fallback): inserts parsed JS rows in batches.
 */
export function mountFileSourceIntoDuckDB(
  projectId: string,
  rows: Record<string, unknown>[],
  columnMapping: FileColumnMapping,
  rawFileBuffer?: Uint8Array | ArrayBuffer,
): Promise<void> {
  // Server mode: the CSV lives on the server and is queried there
  // (queryDataSource routes `filesrc_<id>` to the mapping-projects endpoint).
  // Nothing is mounted in the browser — the raw bytes never come down.
  if (isServerMode()) return Promise.resolve()
  // If already mounted, skip
  if (mountedFileSources.has(projectId)) return Promise.resolve()
  // If a mount is already in flight for this project, return the same promise
  const existing = mountingPromises.get(projectId)
  if (existing) return existing

  const promise = doMountFileSource(projectId, rows, columnMapping, rawFileBuffer)
    .finally(() => mountingPromises.delete(projectId))
  mountingPromises.set(projectId, promise)
  return promise
}

async function doMountFileSource(
  projectId: string,
  rows: Record<string, unknown>[],
  columnMapping: FileColumnMapping,
  rawFileBuffer?: Uint8Array | ArrayBuffer,
): Promise<void> {
  const db = await getDuckDB()
  const conn = await db.connect()
  const dsId = fileSourceDataSourceId(projectId)
  const schema = schemaName(dsId)

  try {
    // Always clean up any leftover schema (may exist from a previous mount in the same session).
    try { await conn.query(`DROP VIEW IF EXISTS "${schema}"."source_concepts"`) } catch { /* ignore */ }
    try { await conn.query(`DROP VIEW IF EXISTS "${schema}"."source_concepts_raw"`) } catch { /* ignore */ }
    try { await conn.query(`DROP TABLE IF EXISTS "${schema}"."source_concepts"`) } catch { /* ignore */ }
    try { await conn.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* ignore */ }

    await conn.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

    if (rawFileBuffer && rawFileBuffer.byteLength > 0) {
      // --- Fast path: read_csv_auto from raw file buffer ---
      const fileName = `filesrc_${projectId}.csv`
      await db.registerFileBuffer(fileName, new Uint8Array(rawFileBuffer))

      // Build column aliases: rename file columns to normalized names
      const selectCols: string[] = []

      // concept_id: from mapped column or row number
      if (columnMapping.conceptIdColumn) {
        selectCols.push(`COALESCE(TRY_CAST("${esc(columnMapping.conceptIdColumn)}" AS INTEGER), row_number() OVER ()) AS concept_id`)
      } else {
        selectCols.push('row_number() OVER () AS concept_id')
      }

      if (columnMapping.conceptNameColumn) {
        selectCols.push(`CAST("${esc(columnMapping.conceptNameColumn)}" AS VARCHAR) AS concept_name`)
      } else {
        selectCols.push("'' AS concept_name")
      }

      if (columnMapping.conceptCodeColumn) {
        selectCols.push(`CAST("${esc(columnMapping.conceptCodeColumn)}" AS VARCHAR) AS concept_code`)
      } else {
        selectCols.push("'' AS concept_code")
      }

      if (columnMapping.terminologyColumn) {
        const col = esc(columnMapping.terminologyColumn)
        selectCols.push(`CAST("${col}" AS VARCHAR) AS vocabulary_id`)
        selectCols.push(`CAST("${col}" AS VARCHAR) AS terminology_name`)
      }
      if (columnMapping.domainColumn) {
        selectCols.push(`CAST("${esc(columnMapping.domainColumn)}" AS VARCHAR) AS domain_id`)
      }
      if (columnMapping.conceptClassColumn) {
        selectCols.push(`CAST("${esc(columnMapping.conceptClassColumn)}" AS VARCHAR) AS concept_class_id`)
      }
      if (columnMapping.categoryColumn) {
        selectCols.push(`CAST("${esc(columnMapping.categoryColumn)}" AS VARCHAR) AS category`)
      }
      if (columnMapping.subcategoryColumn) {
        selectCols.push(`CAST("${esc(columnMapping.subcategoryColumn)}" AS VARCHAR) AS subcategory`)
      }
      if (columnMapping.recordCountColumn) {
        selectCols.push(`COALESCE(TRY_CAST("${esc(columnMapping.recordCountColumn)}" AS INTEGER), 0) AS record_count`)
      }
      if (columnMapping.patientCountColumn) {
        selectCols.push(`COALESCE(TRY_CAST("${esc(columnMapping.patientCountColumn)}" AS INTEGER), 0) AS patient_count`)
      }
      if (columnMapping.infoJsonColumn) {
        selectCols.push(`CAST("${esc(columnMapping.infoJsonColumn)}" AS VARCHAR) AS info_json`)
      }

      // Drop duplicate source concepts (same vocabulary_id + concept_code),
      // keeping the first row. This is the single dedup point for file sources
      // (the stored CSV is kept verbatim — see restoreFileSourceDataFromCsv);
      // duplicates would otherwise give colliding row-position concept_ids and an
      // ambiguous "mapped" state. Mirrors the server (db_connect.query_file_source).
      const dedupCols = columnMapping.terminologyColumn
        ? 'vocabulary_id, concept_code'
        : 'concept_code'
      // Raw (pre-dedup) view, then the deduped view queried by the app. Duplicate
      // source concepts (same vocabulary_id + concept_code) are dropped, keeping
      // the first row. The raw view lets the UI count how many were dropped.
      await conn.query(
        `CREATE VIEW "${schema}"."source_concepts_raw" AS SELECT ${selectCols.join(', ')} FROM read_csv_auto('${fileName}', nullstr='NA')`,
      )
      await conn.query(
        `CREATE VIEW "${schema}"."source_concepts" AS ` +
        `SELECT * FROM "${schema}"."source_concepts_raw" ` +
        `QUALIFY row_number() OVER (PARTITION BY ${dedupCols} ORDER BY concept_id) = 1`,
      )
    } else {
      // --- Legacy fallback: insert parsed rows ---
      const colDefs: string[] = [
        'concept_id INTEGER',
        'concept_name VARCHAR',
        'concept_code VARCHAR',
      ]
      const hasVocab = !!columnMapping.terminologyColumn
      const hasDomain = !!columnMapping.domainColumn
      const hasClass = !!columnMapping.conceptClassColumn
      const hasCategory = !!columnMapping.categoryColumn
      const hasSubcategory = !!columnMapping.subcategoryColumn
      const hasRecordCount = !!columnMapping.recordCountColumn
      const hasPatientCount = !!columnMapping.patientCountColumn
      const hasInfoJson = !!columnMapping.infoJsonColumn

      if (hasVocab) { colDefs.push('vocabulary_id VARCHAR'); colDefs.push('terminology_name VARCHAR') }
      if (hasDomain) colDefs.push('domain_id VARCHAR')
      if (hasClass) colDefs.push('concept_class_id VARCHAR')
      if (hasCategory) colDefs.push('category VARCHAR')
      if (hasSubcategory) colDefs.push('subcategory VARCHAR')
      if (hasRecordCount) colDefs.push('record_count INTEGER')
      if (hasPatientCount) colDefs.push('patient_count INTEGER')
      if (hasInfoJson) colDefs.push('info_json VARCHAR')

      await conn.query(`CREATE TABLE "${schema}"."source_concepts" (${colDefs.join(', ')})`)

      const BATCH = 5000
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)
        const valueParts: string[] = []

        for (let j = 0; j < batch.length; j++) {
          const row = batch[j]
          const globalIdx = i + j
          const conceptId = columnMapping.conceptIdColumn
            ? (Number(row[columnMapping.conceptIdColumn]) || globalIdx + 1)
            : globalIdx + 1
          const conceptName = columnMapping.conceptNameColumn
            ? String(row[columnMapping.conceptNameColumn] ?? '')
            : ''
          const conceptCode = columnMapping.conceptCodeColumn
            ? String(row[columnMapping.conceptCodeColumn] ?? '')
            : ''

          const vals: string[] = [
            String(conceptId),
            `'${esc(conceptName)}'`,
            `'${esc(conceptCode)}'`,
          ]

          if (hasVocab) {
            const v = String(row[columnMapping.terminologyColumn!] ?? '')
            vals.push(`'${esc(v)}'`)
            vals.push(`'${esc(v)}'`)
          }
          if (hasDomain) vals.push(`'${esc(String(row[columnMapping.domainColumn!] ?? ''))}'`)
          if (hasClass) vals.push(`'${esc(String(row[columnMapping.conceptClassColumn!] ?? ''))}'`)
          if (hasCategory) vals.push(`'${esc(String(row[columnMapping.categoryColumn!] ?? ''))}'`)
          if (hasSubcategory) vals.push(`'${esc(String(row[columnMapping.subcategoryColumn!] ?? ''))}'`)
          if (hasRecordCount) vals.push(String(Number(row[columnMapping.recordCountColumn!]) || 0))
          if (hasPatientCount) vals.push(String(Number(row[columnMapping.patientCountColumn!]) || 0))
          if (hasInfoJson) {
            const raw = row[columnMapping.infoJsonColumn!]
            const jsonStr = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : ''
            vals.push(`'${esc(jsonStr)}'`)
          }

          valueParts.push(`(${vals.join(', ')})`)
        }

        await conn.query(`INSERT INTO "${schema}"."source_concepts" VALUES ${valueParts.join(', ')}`)
      }
    }

    mountedFileSources.add(projectId)
  } catch (err) {
    // Clean up on failure
    try { await conn.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* ignore */ }
    throw err
  } finally {
    await conn.close()
  }
}

/** Unmount a file source project from DuckDB. */
export async function unmountFileSource(projectId: string): Promise<void> {
  if (!mountedFileSources.has(projectId)) return
  const db = await getDuckDB()
  const conn = await db.connect()
  const dsId = fileSourceDataSourceId(projectId)
  const schema = schemaName(dsId)
  try {
    await conn.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } catch { /* ignore */ }
  finally {
    mountedFileSources.delete(projectId)
    await conn.close()
  }
}

/** SQL-escape a string value (single quotes). */
function esc(s: string): string {
  return s.replace(/'/g, "''")
}
