/**
 * Extract a database project's source concepts into the flat table the rest of
 * the app reads.
 *
 * A database source is never read into the editor as it stands: profiling a
 * concept scans the event tables, so doing that for a whole dictionary the
 * moment a page opens can take hours. Instead the user runs the extraction, in
 * batches they size, and what comes out is a CSV — the same one an imported
 * file would have been. From then on the project is read, exported and versioned
 * by the file path, and the two kinds of project stop differing.
 *
 * Resumability is the reason this is written in batches rather than as one
 * query: `SourceExtraction.extracted` is the offset the next run starts from, so
 * a run interrupted at 3000 of 40000 concepts resumes at 3000 rather than
 * starting over.
 *
 * Pure except for the caller-supplied `query`: no store writes, no DuckDB
 * imports. The tab owns persistence, this owns what to ask and in what order.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import type { FileColumnMapping } from '@/types'
import {
  buildConceptProfile,
  type ProfileOptions,
  type ProfileSource,
} from './concept-profile'
import { csvEscape } from './export'

/** Execute SQL against the source database and return its rows. */
export type QueryFn = (sql: string) => Promise<Record<string, unknown>[]>

/**
 * The CSV this writes, column by column.
 *
 * These names are a contract, not a preference: `restoreFileSourceDataFromCsv`
 * recognises a re-imported source by them, so renaming one here silently breaks
 * the git round trip of every extracted project.
 *
 * `info_json` is last because it is by far the widest column, and a human
 * scanning the CSV wants the identity columns first.
 */
export const EXTRACTION_COLUMNS = [
  'terminology',
  'concept_code',
  'concept_id',
  'concept_name',
  'category',
  'record_count',
  'patient_count',
  'info_json',
] as const

/**
 * The column mapping an extracted CSV needs, matching EXTRACTION_COLUMNS.
 *
 * Written onto the project alongside the CSV so the source view knows what each
 * column means without re-deriving it.
 */
export const EXTRACTION_COLUMN_MAPPING: FileColumnMapping = {
  terminologyColumn: 'terminology',
  conceptCodeColumn: 'concept_code',
  conceptIdColumn: 'concept_id',
  conceptNameColumn: 'concept_name',
  categoryColumn: 'category',
  recordCountColumn: 'record_count',
  patientCountColumn: 'patient_count',
  infoJsonColumn: 'info_json',
}

/** One concept as the dictionary describes it, before profiling. */
export interface DictionaryConcept {
  concept_id: number
  concept_code: string | null
  concept_name: string | null
  vocabulary_id: string | null
  category: string | null
}

/** One finished row of the extracted CSV. */
export interface ExtractedConcept {
  terminology: string
  concept_code: string
  concept_id: number
  concept_name: string
  category: string
  record_count: number
  patient_count: number | null
  info_json: string
}

/**
 * Count the concepts an extraction will walk.
 *
 * Taken once when a run starts and kept on the extraction state: the dictionary
 * could gain rows mid-run, and a total that moved under the progress bar would
 * make "3000 of 40000" meaningless.
 */
export function buildDictionaryCountQuery(source: ProfileSource): string {
  return `SELECT COUNT(*) AS total FROM "${source.dictionary.table}"`
}

/**
 * One page of the dictionary, in a stable order.
 *
 * Ordered by the key, not by name: paging with LIMIT/OFFSET is only a stable
 * window over a total order, and two concepts sharing a name would otherwise
 * swap between pages — one extracted twice, another never.
 *
 * Falls back to a hash of the code when the dictionary has no key column, the
 * same expression `buildConceptUnionParts` uses, so a concept keeps one id
 * across the source view and the extraction.
 */
export function buildDictionaryPageQuery(
  source: ProfileSource,
  limit: number,
  offset: number,
): string {
  const dict = source.dictionary
  const idExpr = dict.idColumn
    ? `d."${dict.idColumn}"`
    : `(hash(d."${dict.codeColumn ?? dict.nameColumn}") % 2147483647)::INTEGER`
  const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn
  return `SELECT
    ${idExpr} AS concept_id,
    ${dict.codeColumn ? `CAST(d."${dict.codeColumn}" AS VARCHAR)` : `CAST(${idExpr} AS VARCHAR)`} AS concept_code,
    d."${dict.nameColumn}" AS concept_name,
    ${vocabCol ? `CAST(d."${vocabCol}" AS VARCHAR)` : `'${dict.table}'`} AS vocabulary_id,
    ${dict.categoryColumn ? `CAST(d."${dict.categoryColumn}" AS VARCHAR)` : 'NULL'} AS category
  FROM "${dict.table}" d
  ORDER BY ${idExpr}
  LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`
}

/** Serialize one extracted row's values in EXTRACTION_COLUMNS order. */
function toCsvLine(row: ExtractedConcept): string {
  return EXTRACTION_COLUMNS.map((c) => csvEscape(row[c])).join(',')
}

/** The CSV header, on its own so a resumed run can tell it from a first one. */
export function extractionCsvHeader(): string {
  return EXTRACTION_COLUMNS.join(',')
}

/** Serialize a batch's rows, with no header — the caller appends. */
export function extractionCsvRows(rows: ExtractedConcept[]): string {
  return rows.map(toCsvLine).join('\n')
}

/** What one batch produced, and whether there is more to do. */
export interface BatchResult {
  rows: ExtractedConcept[]
  /** Offset the next batch should start from. */
  nextOffset: number
  /** True when the dictionary has been walked to the end. */
  done: boolean
}

/** Reported after each concept so the UI can show progress within a batch. */
export type ProgressFn = (extracted: number, total: number) => void

/**
 * Extract one batch of concepts, profiling each.
 *
 * Concepts are profiled one at a time rather than in parallel: every block is a
 * scan of the same event table, and a warehouse answers one at a time faster
 * than it answers eight competing ones. This is also what makes cancellation
 * responsive — `signal` is checked between concepts, so stopping is immediate
 * rather than waiting for a fan-out to drain.
 *
 * A concept whose profile fails still yields a row, carrying its identity and
 * an empty `info_json`. Dropping it instead would leave a hole in the source
 * the editor could never show, and one bad concept must not cost the batch.
 */
export async function extractBatch(
  mapping: SchemaMapping,
  source: ProfileSource,
  options: ProfileOptions,
  offset: number,
  batchSize: number,
  total: number,
  query: QueryFn,
  signal?: AbortSignal,
  onProgress?: ProgressFn,
): Promise<BatchResult> {
  const page = await query(buildDictionaryPageQuery(source, batchSize, offset))
  if (page.length === 0) return { rows: [], nextOffset: offset, done: true }

  const rows: ExtractedConcept[] = []
  for (const raw of page) {
    if (signal?.aborted) break
    const concept = raw as unknown as DictionaryConcept
    const conceptId = Number(concept.concept_id)
    const conceptName = concept.concept_name == null ? '' : String(concept.concept_name)

    const profile = await buildConceptProfile(
      mapping, source,
      { conceptId, conceptName, category: concept.category ?? undefined },
      options, query,
    )

    rows.push({
      terminology: concept.vocabulary_id ?? '',
      concept_code: concept.concept_code == null ? '' : String(concept.concept_code),
      concept_id: conceptId,
      concept_name: conceptName,
      category: concept.category ?? '',
      record_count: profile.rowsCount,
      patient_count: profile.patientsCount,
      // An empty cell, not "null": the source view parses this column as JSON and
      // treats anything unparseable as absent, which is what a withheld profile is.
      info_json: profile.json ? JSON.stringify(profile.json) : '',
    })
    onProgress?.(offset + rows.length, total)
  }

  const nextOffset = offset + rows.length
  // Short page means the dictionary is exhausted — but only if the batch ran to
  // completion. An aborted batch is short for a different reason, and calling it
  // done would strand the rest of the dictionary.
  const done = !signal?.aborted && page.length < batchSize
  return { rows, nextOffset, done }
}
