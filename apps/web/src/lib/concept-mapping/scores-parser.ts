import { getDuckDB } from '@/lib/duckdb/engine'
import type { SuggestionScore } from '@/types'

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

const DEFAULT_EQUIVALENCE = 'skos:exactMatch'

const TEMP_FILE = '__scores_import_tmp__'

/**
 * Parse a parquet or CSV scores file using DuckDB WASM.
 * Returns raw rows; the caller is responsible for wrapping them into SuggestionScore objects.
 */
export async function parseScoresFile(file: File): Promise<ParsedScoreRow[]> {
  const db = await getDuckDB()
  const buffer = await file.arrayBuffer()
  const lower = file.name.toLowerCase()
  const isParquet = lower.endsWith('.parquet') || lower.endsWith('.pq')
  const fileName = `${TEMP_FILE}${isParquet ? '.parquet' : '.csv'}`

  await db.registerFileBuffer(fileName, new Uint8Array(buffer))

  const conn = await db.connect()
  try {
    const readFn = isParquet ? 'read_parquet' : 'read_csv_auto'
    const result = await conn.query(`SELECT * FROM ${readFn}('${fileName}')`)

    const rows: ParsedScoreRow[] = []
    for (const row of result.toArray()) {
      const r = row.toJSON() as Record<string, unknown>
      const sourceVocabId = String(r.source_vocabulary_id ?? r.vocabulary_id ?? r.terminology ?? '')
      const sourceConceptCode = String(r.source_concept_code ?? r.concept_code ?? r.code ?? '')
      const conceptId = Number(r.concept_id ?? 0)
      const method = String(r.method ?? '')
      const score = Number(r.score ?? 0)

      if (!sourceVocabId || !sourceConceptCode || !conceptId || !method) continue

      const equivalence = r.equivalence != null && String(r.equivalence) !== ''
        ? String(r.equivalence)
        : DEFAULT_EQUIVALENCE
      const comment = r.comment != null && String(r.comment) !== '' ? String(r.comment) : null
      const createdAt = r.created_at != null && String(r.created_at) !== '' ? String(r.created_at) : null

      rows.push({
        source_vocabulary_id: sourceVocabId,
        source_concept_code: sourceConceptCode,
        concept_id: conceptId,
        method,
        score,
        equivalence,
        comment,
        created_at: createdAt,
      })
    }
    return rows
  } finally {
    conn.close()
    db.dropFile(fileName)
  }
}

export function scoresToSuggestionScores(
  rows: ParsedScoreRow[],
): Omit<SuggestionScore, 'id' | 'importedAt' | 'projectId'>[] {
  return rows.map((r) => ({
    sourceVocabularyId: r.source_vocabulary_id,
    sourceConceptCode: r.source_concept_code,
    conceptId: r.concept_id,
    method: r.method,
    score: r.score,
    equivalence: r.equivalence,
    comment: r.comment,
    createdAt: r.created_at,
  }))
}
