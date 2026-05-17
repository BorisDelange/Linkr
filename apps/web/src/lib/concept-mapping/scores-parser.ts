import { getDuckDB } from '@/lib/duckdb/engine'

export interface ParsedScoreRow {
  source_vocabulary_id: string
  source_concept_code: string
  concept_id: number
  method: string
  score: number
  equivalence: string
  comment: string | null
  created_at: string | null
}

const TEMP_FILE = '__scores_validate_tmp__'

const REQUIRED_COLUMNS = ['source_vocabulary_id', 'source_concept_code', 'concept_id', 'method', 'score'] as const

export type ValidationResult =
  | { ok: true; isParquet: boolean }
  | { ok: false; error: string }

/**
 * Validate a scores file by reading a single row and checking required columns.
 * Does not materialise the full dataset — the parquet is later registered in
 * DuckDB and queried on demand by `scores-engine`.
 */
export async function validateScoresFile(file: File): Promise<ValidationResult> {
  const db = await getDuckDB()
  const buffer = await file.arrayBuffer()
  const lower = file.name.toLowerCase()
  const isParquet = lower.endsWith('.parquet') || lower.endsWith('.pq')
  const fileName = `${TEMP_FILE}${isParquet ? '.parquet' : '.csv'}`

  await db.registerFileBuffer(fileName, new Uint8Array(buffer))

  const conn = await db.connect()
  try {
    const readFn = isParquet ? 'read_parquet' : 'read_csv_auto'
    const result = await conn.query(`SELECT * FROM ${readFn}('${fileName}') LIMIT 1`)
    if (result.numRows === 0) {
      return { ok: false, error: 'Scores file is empty.' }
    }
    const row = result.toArray()[0]?.toJSON() as Record<string, unknown> | undefined
    if (!row) return { ok: false, error: 'Scores file is empty.' }

    const missing = REQUIRED_COLUMNS.filter((col) => !(col in row))
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Missing required columns: ${missing.join(', ')}. Expected: ${REQUIRED_COLUMNS.join(', ')}.`,
      }
    }
    return { ok: true, isParquet }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await conn.close()
    try { await db.dropFile(fileName) } catch { /* ignore */ }
  }
}
