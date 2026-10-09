import {
  queryDataSourceAll,
  fileSourceDataSourceId,
  isFileSourceMounted,
  mountFileSourceIntoDuckDB,
} from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'
import { getTotalSourceConcepts } from './mapping-status'
import type { MappingProject } from '@/types'

/** A source concept as every "include all source concepts" path needs it. */
export interface SourceConceptRow {
  vocabularyId: string
  conceptCode: string
  conceptName: string
}

/**
 * Every source concept of a mapping project, mapped or not.
 *
 * Shared by the mapping project's Export tab and the ETL Vocabulary tab: both
 * offer "include all source concepts", and both read the project's flat table —
 * an imported file, or a database project's extraction. A database project not
 * extracted yet has none.
 */
export async function loadAllSourceConcepts(project: MappingProject): Promise<SourceConceptRow[]> {
  if (!project.fileSourceData) return []
  // Newer projects keep the raw file and read it through DuckDB; rows[] is a
  // legacy fallback (an export empties it, keeping only totalRowCount).
  try {
    if (!isFileSourceMounted(project.id)) {
      await mountFileSourceIntoDuckDB(
        project.id,
        project.fileSourceData.rows,
        project.fileSourceData.columnMapping,
        project.fileSourceData.rawFileBuffer,
      )
    }
    // queryDataSourceAll, not queryDataSource: server mode caps a single
    // response at MAX_QUERY_ROWS (~10k), silently truncating a large
    // dictionary.
    const rows = await queryDataSourceAll(
      fileSourceDataSourceId(project.id),
      'SELECT vocabulary_id, concept_code, concept_name FROM source_concepts',
    )
    const out = rows.map((r) => ({
      vocabularyId: String(r.vocabulary_id ?? localized(project.name, 'en')),
      conceptCode: String(r.concept_code ?? ''),
      conceptName: String(r.concept_name ?? ''),
    })).filter((c) => c.conceptCode)
    if (out.length > 0) return out
  } catch { /* fall through to legacy rows[] */ }

  const colMapping = project.fileSourceData.columnMapping
  const codeCol = colMapping?.conceptCodeColumn
  const vocabCol = colMapping?.terminologyColumn
  const nameCol = colMapping?.conceptNameColumn
  const out: SourceConceptRow[] = []
  for (const row of project.fileSourceData.rows ?? []) {
    const code = codeCol ? String(row[codeCol] ?? '') : ''
    if (!code) continue
    out.push({
      vocabularyId: vocabCol ? String(row[vocabCol] ?? '') : localized(project.name, 'en'),
      conceptCode: code,
      conceptName: nameCol ? String(row[nameCol] ?? '') : code,
    })
  }
  return out
}

/** How many source concepts the project holds, without loading them. */
export function countAllSourceConcepts(project: MappingProject): number | null {
  return project.fileSourceData ? getTotalSourceConcepts(project) : null
}
