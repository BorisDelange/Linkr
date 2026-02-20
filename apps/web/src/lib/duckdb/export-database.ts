import JSZip from 'jszip'
import { getDuckDB, discoverTables, schemaName, isAttachedSource } from './engine'

export type ExportFormat = 'parquet-zip'

export interface ExportProgress {
  currentTable: number
  totalTables: number
  tableName: string
  phase: 'discovering' | 'exporting' | 'packaging' | 'done'
}

export type ProgressCallback = (progress: ExportProgress) => void

/**
 * Set the search_path for a data source connection, matching queryDataSource logic.
 */
async function setSearchPath(
  conn: import('@duckdb/duckdb-wasm').AsyncDuckDBConnection,
  dataSourceId: string,
  schema: string,
): Promise<void> {
  if (isAttachedSource(dataSourceId)) {
    await conn.query(`SET search_path TO "${schema}".main`)
  } else {
    await conn.query(`SET search_path TO "${schema}"`)
  }
}

/**
 * Export a data source as a ZIP of Parquet files.
 *
 * For each non-empty table:
 * 1. Set search_path to the source schema
 * 2. COPY table TO Parquet in DuckDB's virtual filesystem
 * 3. copyFileToBuffer() to extract bytes
 * 4. Add to JSZip (STORE — Parquet is already zstd-compressed)
 * 5. dropFile() to free memory
 */
export async function exportAsParquetZip(
  dataSourceId: string,
  onProgress?: ProgressCallback,
  abortSignal?: AbortSignal,
): Promise<Blob> {
  const db = await getDuckDB()
  const conn = await db.connect()
  const schema = schemaName(dataSourceId)

  try {
    // Set search_path so unqualified table names resolve correctly
    await setSearchPath(conn, dataSourceId, schema)

    onProgress?.({ currentTable: 0, totalTables: 0, tableName: '', phase: 'discovering' })

    const allTables = await discoverTables(dataSourceId)

    // Filter to non-empty tables
    const tablesToExport: string[] = []
    for (const table of allTables) {
      try {
        const r = await conn.query(`SELECT COUNT(*) as cnt FROM "${table}"`)
        const count = Number(r.toArray()[0]?.cnt ?? 0)
        if (count > 0) tablesToExport.push(table)
      } catch {
        // Skip tables that can't be queried
      }
    }

    const totalTables = tablesToExport.length
    const zip = new JSZip()

    for (let i = 0; i < tablesToExport.length; i++) {
      if (abortSignal?.aborted) throw new Error('Export cancelled')

      const table = tablesToExport[i]
      const parquetFile = `__export_${table}.parquet`

      onProgress?.({ currentTable: i + 1, totalTables, tableName: table, phase: 'exporting' })

      await conn.query(`COPY "${table}" TO '${parquetFile}' (FORMAT PARQUET, COMPRESSION 'zstd')`)

      const buffer = await db.copyFileToBuffer(parquetFile)
      zip.file(`${table}.parquet`, buffer, { compression: 'STORE' })
      await db.dropFile(parquetFile)
    }

    onProgress?.({ currentTable: totalTables, totalTables, tableName: '', phase: 'packaging' })

    const blob = await zip.generateAsync({ type: 'blob' })

    onProgress?.({ currentTable: totalTables, totalTables, tableName: '', phase: 'done' })

    return blob
  } finally {
    // Reset search_path to main
    try { await conn.query('SET search_path TO main') } catch { /* ignore */ }
    await conn.close()
  }
}

// Note: DuckDB file export is not supported in DuckDB-WASM (ATTACH in write mode
// doesn't work reliably in the browser virtual filesystem). Use Parquet ZIP instead.
