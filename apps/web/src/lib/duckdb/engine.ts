import * as duckdb from '@duckdb/duckdb-wasm'
import type { DataSource, DatabaseConnectionConfig, StoredFile, StoredFileHandle, DataSourceStats, SchemaMapping } from '@/types'

// DuckDB WASM assets are served from public/duckdb/ to avoid Vite @fs blocking.
// After `npm install`, run: cp node_modules/@duckdb/duckdb-wasm/dist/{duckdb-mvp.wasm,duckdb-eh.wasm,duckdb-browser-mvp.worker.js,duckdb-browser-eh.worker.js} public/duckdb/
const duckdb_mvp_wasm = new URL('/duckdb/duckdb-mvp.wasm', import.meta.url).href
const duckdb_mvp_worker = new URL('/duckdb/duckdb-browser-mvp.worker.js', import.meta.url).href
const duckdb_eh_wasm = new URL('/duckdb/duckdb-eh.wasm', import.meta.url).href
const duckdb_eh_worker = new URL('/duckdb/duckdb-browser-eh.worker.js', import.meta.url).href

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

/** Sanitized schema name for a data source. */
function schemaName(dataSourceId: string): string {
  return 'ds_' + dataSourceId.replace(/[^a-zA-Z0-9]/g, '_')
}

/** Track which data sources are ATTACHed (vs schema-based). */
const attachedSources = new Set<string>()

// --- Mount / unmount ---

/**
 * Mount a data source into DuckDB.
 * Registers files and creates views/ATTACHes the database.
 */
export async function mountDataSource(
  dataSource: DataSource,
  files: StoredFile[],
): Promise<void> {
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSource.id)
  const config = dataSource.connectionConfig as DatabaseConnectionConfig

  try {
    // Clean up any leftover schema from a previous failed mount
    await safeDropSchema(conn, dataSource.id)

    if (config.fileIds && config.fileIds.length > 0) {
      // Multi-parquet folder mode -> create schema + views per table
      const knownTables = dataSource.schemaMapping?.knownTables
      await mountParquetFolder(db, conn, schema, files, knownTables)
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
    await conn.query(`SET search_path TO "${schema}"`)
    const result = await conn.query(sql)
    return result.toArray() as Record<string, unknown>[]
  } finally {
    await conn.close()
  }
}

// --- Helpers ---

/** Drop a schema (or DETACH) if it already exists, ignoring errors. */
async function safeDropSchema(
  conn: duckdb.AsyncDuckDBConnection,
  dataSourceId: string,
): Promise<void> {
  const schema = schemaName(dataSourceId)
  try {
    if (attachedSources.has(dataSourceId)) {
      await conn.query(`DETACH "${schema}"`)
      attachedSources.delete(dataSourceId)
    } else {
      await conn.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  } catch {
    // Ignore — schema may not exist yet
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

/** Mount a folder of Parquet files as views in a DuckDB schema. */
async function mountParquetFolder(
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

    // Create a view using read_parquet with all files for this table
    const fileList = registeredNames.map((n) => `'${n}'`).join(', ')
    const reader = registeredNames.length === 1
      ? `read_parquet('${registeredNames[0]}')`
      : `read_parquet([${fileList}])`
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
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSource.id)
  const config = dataSource.connectionConfig as DatabaseConnectionConfig

  try {
    // Clean up any leftover schema from a previous failed mount
    await safeDropSchema(conn, dataSource.id)

    if (config.fileIds && config.fileIds.length > 0) {
      // Multi-parquet folder mode
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

        const fileList = registeredNames.map((n) => `'${n}'`).join(', ')
        const reader = registeredNames.length === 1
          ? `read_parquet('${registeredNames[0]}')`
          : `read_parquet([${fileList}])`
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
