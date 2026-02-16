import * as duckdb from '@duckdb/duckdb-wasm'
import type { DatasetColumn, ColumnStats } from '@/types'

let _db: duckdb.AsyncDuckDB | null = null
let _conn: duckdb.AsyncDuckDBConnection | null = null

async function getConn(): Promise<duckdb.AsyncDuckDBConnection> {
  if (_conn) return _conn
  const BUNDLES = {
    mvp: {
      mainModule: '/duckdb/duckdb-mvp.wasm',
      mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
    },
    eh: {
      mainModule: '/duckdb/duckdb-eh.wasm',
      mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
    },
  }
  const bundle = await duckdb.selectBundle(BUNDLES)
  const worker = new Worker(bundle.mainWorker!)
  const logger = new duckdb.ConsoleLogger()
  _db = new duckdb.AsyncDuckDB(logger, worker)
  await _db.instantiate(bundle.mainModule)
  _conn = await _db.connect()
  return _conn
}

function tableName(datasetId: string): string {
  return '__ds_' + datasetId.replace(/[^a-zA-Z0-9]/g, '_')
}

function mapType(type: DatasetColumn['type']): string {
  switch (type) {
    case 'number':
      return 'DOUBLE'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATE'
    default:
      return 'VARCHAR'
  }
}

function formatValue(val: unknown, type: DatasetColumn['type']): string {
  if (val === null || val === undefined) return 'NULL'
  if (type === 'number') {
    const num = Number(val)
    return isNaN(num) ? 'NULL' : String(num)
  }
  if (type === 'boolean') return val ? 'TRUE' : 'FALSE'
  return `'${String(val).replace(/'/g, "''")}'`
}

export async function mountDataset(
  datasetId: string,
  rows: Record<string, unknown>[],
  columns: DatasetColumn[]
): Promise<void> {
  try {
    const conn = await getConn()
    const tbl = tableName(datasetId)

    // Drop table if exists
    await conn.query(`DROP TABLE IF EXISTS "${tbl}"`)

    // Create table with explicit types
    const colDefs = columns.map((c) => `"${c.name}" ${mapType(c.type)}`).join(', ')
    await conn.query(`CREATE TABLE "${tbl}" (${colDefs})`)

    // Insert rows in batches (1000 rows at a time)
    const BATCH_SIZE = 1000
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      if (batch.length === 0) continue

      const values = batch
        .map((row) => {
          const vals = columns.map((c) => formatValue(row[c.name], c.type))
          return `(${vals.join(', ')})`
        })
        .join(', ')

      await conn.query(`INSERT INTO "${tbl}" VALUES ${values}`)
    }
  } catch (error) {
    console.error('Failed to mount dataset:', error)
    throw new Error(`Failed to mount dataset ${datasetId}: ${error}`)
  }
}

export async function queryDataset(
  datasetId: string,
  page: number = 0,
  pageSize: number = 100,
  sortCol?: string,
  sortDesc?: boolean
): Promise<Record<string, unknown>[]> {
  try {
    const conn = await getConn()
    const tbl = tableName(datasetId)

    let sql = `SELECT * FROM "${tbl}"`

    if (sortCol) {
      sql += ` ORDER BY "${sortCol}" ${sortDesc ? 'DESC' : 'ASC'}`
    }

    sql += ` LIMIT ${pageSize} OFFSET ${page * pageSize}`

    const result = await conn.query(sql)
    return result.toArray().map((row) => row.toJSON())
  } catch (error) {
    console.error('Failed to query dataset:', error)
    throw new Error(`Failed to query dataset ${datasetId}: ${error}`)
  }
}

export async function getDatasetRowCount(datasetId: string): Promise<number> {
  try {
    const conn = await getConn()
    const tbl = tableName(datasetId)

    const result = await conn.query(`SELECT COUNT(*) as cnt FROM "${tbl}"`)
    const rows = result.toArray()
    return rows.length > 0 ? Number(rows[0].cnt) : 0
  } catch (error) {
    console.error('Failed to get dataset row count:', error)
    throw new Error(`Failed to get dataset row count for ${datasetId}: ${error}`)
  }
}

export async function computeColumnStats(
  datasetId: string,
  column: DatasetColumn
): Promise<ColumnStats> {
  try {
    const conn = await getConn()
    const tbl = tableName(datasetId)
    const colName = column.name

    // Basic stats for all types
    const totalResult = await conn.query(
      `SELECT
        COUNT("${colName}") as count,
        COUNT(*) - COUNT("${colName}") as null_count,
        COUNT(DISTINCT "${colName}") as unique_count
      FROM "${tbl}"`
    )
    const totalRow = totalResult.toArray()[0]
    const count = Number(totalRow.count)
    const nullCount = Number(totalRow.null_count)
    const uniqueCount = Number(totalRow.unique_count)

    const stats: ColumnStats = {
      columnName: column.name,
      columnType: column.type,
      count,
      nullCount,
      uniqueCount,
      distribution: [],
    }

    // Type-specific stats
    if (column.type === 'number') {
      // Numeric statistics
      const numResult = await conn.query(
        `SELECT
          MIN("${colName}") as min_val,
          MAX("${colName}") as max_val,
          AVG("${colName}") as mean_val,
          MEDIAN("${colName}") as median_val,
          STDDEV("${colName}") as std_val
        FROM "${tbl}"
        WHERE "${colName}" IS NOT NULL`
      )
      const numRow = numResult.toArray()[0]

      stats.min = Number(numRow.min_val)
      stats.max = Number(numRow.max_val)
      stats.mean = Number(numRow.mean_val)
      stats.median = Number(numRow.median_val)
      stats.std = Number(numRow.std_val)

      // Histogram (20 bins)
      const histResult = await conn.query(
        `WITH bounds AS (
          SELECT
            MIN("${colName}") as mn,
            MAX("${colName}") as mx
          FROM "${tbl}"
          WHERE "${colName}" IS NOT NULL
        ),
        binned AS (
          SELECT
            FLOOR(("${colName}" - mn) / NULLIF(mx - mn, 0) * 20) as bin_idx,
            mn,
            mx
          FROM "${tbl}", bounds
          WHERE "${colName}" IS NOT NULL
        )
        SELECT
          bin_idx,
          COUNT(*) as count,
          mn + (bin_idx / 20.0) * (mx - mn) as bin_start,
          mn + ((bin_idx + 1) / 20.0) * (mx - mn) as bin_end
        FROM binned
        GROUP BY bin_idx, mn, mx
        ORDER BY bin_idx`
      )

      stats.distribution = histResult.toArray().map((row) => ({
        bucket: `${Number(row.bin_start).toFixed(2)}-${Number(row.bin_end).toFixed(2)}`,
        count: Number(row.count),
      }))
    } else {
      // Categorical distribution (top 20 values)
      const distResult = await conn.query(
        `SELECT
          CAST("${colName}" AS VARCHAR) as bucket,
          COUNT(*) as count
        FROM "${tbl}"
        WHERE "${colName}" IS NOT NULL
        GROUP BY "${colName}"
        ORDER BY count DESC
        LIMIT 20`
      )

      stats.distribution = distResult.toArray().map((row) => ({
        bucket: String(row.bucket),
        count: Number(row.count),
      }))

      // Add null bucket if exists
      if (nullCount > 0) {
        stats.distribution.push({ bucket: 'NULL', count: nullCount })
      }
    }

    return stats
  } catch (error) {
    console.error('Failed to compute column stats:', error)
    throw new Error(`Failed to compute column stats for ${column.name}: ${error}`)
  }
}

export async function computeQuickColumnSummary(
  datasetId: string,
  columns: DatasetColumn[]
): Promise<Map<string, { count: number; nullPct: number }>> {
  try {
    const conn = await getConn()
    const tbl = tableName(datasetId)

    // Build single query with COUNT(*) and COUNT(col) for each column
    const countSelects = columns.map((c) => `COUNT("${c.name}") as "${c.name}_count"`).join(', ')
    const sql = `SELECT COUNT(*) as total, ${countSelects} FROM "${tbl}"`

    const result = await conn.query(sql)
    const row = result.toArray()[0]
    const total = Number(row.total)

    const summary = new Map<string, { count: number; nullPct: number }>()
    for (const col of columns) {
      const count = Number(row[`${col.name}_count`])
      const nullCount = total - count
      const nullPct = total > 0 ? (nullCount / total) * 100 : 0
      summary.set(col.id, { count, nullPct })
    }

    return summary
  } catch (error) {
    console.error('Failed to compute quick column summary:', error)
    throw new Error(`Failed to compute quick column summary for ${datasetId}: ${error}`)
  }
}

export async function unmountDataset(datasetId: string): Promise<void> {
  try {
    const conn = await getConn()
    const tbl = tableName(datasetId)
    await conn.query(`DROP TABLE IF EXISTS "${tbl}"`)
  } catch (error) {
    console.error('Failed to unmount dataset:', error)
    throw new Error(`Failed to unmount dataset ${datasetId}: ${error}`)
  }
}
