import * as duckdb from '@duckdb/duckdb-wasm'
import { Type as ArrowType } from 'apache-arrow'
import type { DataSource, DatabaseConnectionConfig, StoredFile, StoredFileHandle, DataSourceStats, SchemaMapping } from '@/types'

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
