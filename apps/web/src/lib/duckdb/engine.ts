import * as duckdb from '@duckdb/duckdb-wasm'
import { Type as ArrowType } from 'apache-arrow'
import type { DataSource, DatabaseConnectionConfig, StoredFile, StoredFileHandle, DataSourceStats, SchemaMapping, FileColumnMapping } from '@/types'

// DuckDB WASM assets are served from public/duckdb/ to avoid Vite @fs blocking.
// After `npm install`, run: cp node_modules/@duckdb/duckdb-wasm/dist/{duckdb-mvp.wasm,duckdb-eh.wasm,duckdb-browser-mvp.worker.js,duckdb-browser-eh.worker.js} public/duckdb/
const duckdb_mvp_wasm = new URL('/duckdb/duckdb-mvp.wasm', import.meta.url).href
const duckdb_mvp_worker = new URL('/duckdb/duckdb-browser-mvp.worker.js', import.meta.url).href
const duckdb_eh_wasm = new URL('/duckdb/duckdb-eh.wasm', import.meta.url).href
const duckdb_eh_worker = new URL('/duckdb/duckdb-browser-eh.worker.js', import.meta.url).href

/**
 * Split a SQL script into individual statements, respecting single-quoted
 * string literals and `--` line comments so that semicolons inside strings
 * (e.g. `'Sodium Chloride 23.4%;30ML V'`) are not treated as separators.
 */
function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = []
  let current = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    // Single-quoted string literal — consume until closing quote
    if (ch === "'") {
      current += ch
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''"
          i += 2
        } else if (sql[i] === "'") {
          current += "'"
          i++
          break
        } else {
          current += sql[i]
          i++
        }
      }
    // Line comment — consume until end of line
    } else if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      if (nl === -1) { i = sql.length } else { i = nl + 1 }
    // Statement separator
    } else if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed) stmts.push(trimmed)
      current = ''
      i++
    } else {
      current += ch
      i++
    }
  }
  const trimmed = current.trim()
  if (trimmed) stmts.push(trimmed)
  return stmts
}

let _db: duckdb.AsyncDuckDB | null = null
let _initPromise: Promise<duckdb.AsyncDuckDB> | null = null
let _worker: Worker | null = null

/** Try to instantiate DuckDB with a specific bundle (worker URL + WASM URL). */
async function tryInstantiate(
  workerUrl: string,
  wasmUrl: string,
  label: string,
): Promise<duckdb.AsyncDuckDB> {
  const worker = new Worker(workerUrl)
  _worker = worker

  worker.addEventListener('error', (e) => {
    console.error(`[DuckDB:${label}] Worker error:`, e.message)
  })

  const logger = new duckdb.ConsoleLogger()
  const db = new duckdb.AsyncDuckDB(logger, worker)

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

/** Check if a data source is ATTACHed (vs schema-based). */
export function isAttachedSource(dataSourceId: string): boolean {
  return attachedSources.has(dataSourceId)
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
      // Multi-file folder mode -> create schema + views per table
      const knownTables = dataSource.schemaMapping?.knownTables
      await mountFileFolder(db, conn, schema, files, knownTables)
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

    // Create schema + set search path so CREATE TABLE goes into it
    await conn.query(`CREATE SCHEMA "${schema}"`)
    await conn.query(`SET search_path TO "${schema}"`)

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
    // Reset search path even on error
    try { await conn.query(`SET search_path TO main`) } catch {}
    throw err
  } finally {
    await conn.close()
  }
}

// --- Query ---

/** Discover table names in a mounted data source. */
export async function discoverTables(dataSourceId: string): Promise<string[]> {
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    const result = await conn.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`,
    )
    return result.toArray().map((row: Record<string, unknown>) => String(row.table_name))
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
): Promise<DataSourceStats> {
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
      const patientCount = await safeCount(conn, schema, schemaMapping.patientTable.table)
      const visitCount = schemaMapping.visitTable
        ? await safeCount(conn, schema, schemaMapping.visitTable.table)
        : 0
      return { patientCount, visitCount, tableCount }
    }

    return { tableCount }
  } finally {
    await conn.close()
  }
}

/** Run an arbitrary SQL query against a data source schema. */
export async function queryDataSource(
  dataSourceId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    // Try schema-based path first, fall back to catalog.main for ATTACHed databases
    if (attachedSources.has(dataSourceId)) {
      await conn.query(`SET search_path TO "${schema}".main`)
    } else {
      try {
        await conn.query(`SET search_path TO "${schema}"`)
      } catch {
        // Schema might be an ATTACHed catalog — retry with catalog.main
        await conn.query(`SET search_path TO "${schema}".main`)
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
  if (attachedSources.has(dataSourceId)) {
    // ATTACHed database — must DETACH
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

async function safeCount(
  conn: duckdb.AsyncDuckDBConnection,
  schema: string,
  table: string,
): Promise<number> {
  try {
    const r = await conn.query(`SELECT COUNT(*) as cnt FROM "${schema}"."${table}"`)
    return Number(r.toArray()[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

// --- Parquet folder support ---

/**
 * Extract a table name from a file path.
 * If knownTables is provided, matches against that set.
 * Otherwise uses file/directory name heuristic.
 */
export function extractTableName(filePath: string, knownTables?: string[]): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const knownSet = knownTables ? new Set(knownTables) : null

  if (knownSet) {
    // Walk segments from right to left, find the first known table name
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i].replace(/\.[^.]+$/, '').toLowerCase()
      if (knownSet.has(seg)) return seg
    }
  }

  // Fallback: if the file is inside a directory, use the parent directory name
  if (parts.length >= 2) {
    return parts[parts.length - 2].toLowerCase()
  }
  // Last resort: file name without extension
  return parts[parts.length - 1].replace(/\.[^.]+$/, '').toLowerCase()
}

/** Group StoredFile entries by table name. */
export function groupFilesByTable(files: StoredFile[], knownTables?: string[]): Map<string, StoredFile[]> {
  const map = new Map<string, StoredFile[]>()
  for (const file of files) {
    const table = extractTableName(file.fileName, knownTables)
    const group = map.get(table) ?? []
    group.push(file)
    map.set(table, group)
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

/** Mount a folder of data files (Parquet or CSV) as views in a DuckDB schema. */
async function mountFileFolder(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  schema: string,
  files: StoredFile[],
  knownTables?: string[],
): Promise<void> {
  await conn.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  const byTable = groupFilesByTable(files, knownTables)

  for (const [tableName, tableFiles] of byTable) {
    // Register all files for this table
    const registeredNames: string[] = []
    for (const f of tableFiles) {
      await db.registerFileBuffer(f.fileName, new Uint8Array(f.data))
      registeredNames.push(f.fileName)
    }

    const reader = buildReaderExpr(registeredNames)
    await conn.query(
      `CREATE VIEW "${schema}"."${tableName}" AS SELECT * FROM ${reader}`,
    )
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

/** Group StoredFileHandle entries by table name. */
function groupHandlesByTable(handles: StoredFileHandle[], knownTables?: string[]): Map<string, StoredFileHandle[]> {
  const map = new Map<string, StoredFileHandle[]>()
  for (const h of handles) {
    const table = extractTableName(h.fileName, knownTables)
    const group = map.get(table) ?? []
    group.push(h)
    map.set(table, group)
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
      // Multi-file folder mode
      await conn.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      const knownTables = dataSource.schemaMapping?.knownTables
      const byTable = groupHandlesByTable(handles, knownTables)

      for (const [tableName, tableHandles] of byTable) {
        const registeredNames: string[] = []
        for (const h of tableHandles) {
          const file = await h.handle.getFile()
          await db.registerFileHandle(
            h.fileName,
            file,
            duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
            true,
          )
          registeredNames.push(h.fileName)
        }

        const reader = buildReaderExpr(registeredNames)
        await conn.query(
          `CREATE VIEW "${schema}"."${tableName}" AS SELECT * FROM ${reader}`,
        )
      }
    } else if (handles.length > 0) {
      // Single file -> ATTACH
      const h = handles[0]
      const file = await h.handle.getFile()
      await db.registerFileHandle(
        h.fileName,
        file,
        duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
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

      await conn.query(
        `CREATE VIEW "${schema}"."source_concepts" AS SELECT ${selectCols.join(', ')} FROM read_csv_auto('${fileName}')`,
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
