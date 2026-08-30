import {
  queryDataSource,
  queryDataSourceAll,
  fileSourceDataSourceId,
  isFileSourceMounted,
  mountFileSourceIntoDuckDB,
} from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'
import { buildSourceConceptsAllQuery, buildSourceConceptsCountQuery } from './mapping-queries'
import { getTotalSourceConcepts, readsFromFlatSource } from './mapping-status'
import type { DataSource, MappingProject } from '@/types'

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
 * offer "include all source concepts", and both have to read the dictionary the
 * same way — a file project through its DuckDB-mounted `source_concepts`, a
 * database project through the source table.
 */
export async function loadAllSourceConcepts(
  project: MappingProject,
  dataSource: DataSource | undefined,
  ensureMounted: (dsId: string) => Promise<void>,
): Promise<SourceConceptRow[]> {
  // `readsFromFlatSource`, not `sourceType === 'file'`: a database project whose
  // Source concepts tab has extracted its dictionary writes the same
  // `fileSourceData`, and from then on is read the same way.
  if (readsFromFlatSource(project)) {
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

  if (dataSource?.schemaMapping) {
    try {
      await ensureMounted(dataSource.id)
      const sql = buildSourceConceptsAllQuery(dataSource.schemaMapping, {})
      if (sql) {
        const rows = await queryDataSourceAll(dataSource.id, sql)
        return rows.map((r) => ({
          vocabularyId: String(r.vocabulary_id ?? dataSource.id),
          conceptCode: String(r.concept_code ?? ''),
          conceptName: String(r.concept_name ?? ''),
        })).filter((c) => c.conceptCode)
      }
    } catch { /* skip if unavailable */ }
  }
  return []
}

/**
 * How many source concepts the project holds, without loading them.
 *
 * Drives the "include all source concepts" counter, so it stays a COUNT query on
 * the database side rather than the length of a fetched list.
 */
export async function countAllSourceConcepts(
  project: MappingProject,
  dataSource: DataSource | undefined,
  ensureMounted: (dsId: string) => Promise<void>,
): Promise<number | null> {
  if (readsFromFlatSource(project)) return getTotalSourceConcepts(project)
  if (!dataSource?.id || !dataSource.schemaMapping) return null
  try {
    await ensureMounted(dataSource.id)
    const sql = buildSourceConceptsCountQuery(dataSource.schemaMapping, {})
    if (!sql) return null
    const [row] = await queryDataSource(dataSource.id, sql)
    return Number(row?.total ?? 0)
  } catch {
    return null
  }
}
