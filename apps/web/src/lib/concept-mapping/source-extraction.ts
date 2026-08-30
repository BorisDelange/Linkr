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
 * What to screen first.
 *
 * A dictionary is walked once, over hours, and which end it is walked from
 * decides what the user can act on today. The busiest concepts first is usually
 * the right answer — they are the ones a mapping project lives or dies on —
 * but a review that follows a coding list wants the code order instead.
 *
 * `records` and `patients` are not columns of the dictionary: they are counted
 * by a preliminary pass (see `buildConceptCountsQuery`). The others the
 * dictionary can order by directly, at no cost.
 */
export type ExtractionSortKey = 'id' | 'code' | 'name' | 'records' | 'patients'

export interface ExtractionSort {
  key: ExtractionSortKey
  direction: 'asc' | 'desc'
}

/**
 * Busiest concepts first.
 *
 * An extraction runs for hours and is often stopped before the end, so the
 * default decides what most users actually get: the concepts the warehouse holds
 * the most data for, which are the ones a mapping project lives on. It costs the
 * counting pass, which is one scan against many hours of profiling.
 */
export const DEFAULT_EXTRACTION_SORT: ExtractionSort = { key: 'records', direction: 'desc' }

/** The dictionary's own key order — total, free, and needing no ranking. */
const KEY_ORDER: ExtractionSort = { key: 'id', direction: 'asc' }

/** Whether this sort needs the counting pass before anything can be profiled. */
export function sortNeedsCounts(sort: ExtractionSort): boolean {
  return sort.key === 'records' || sort.key === 'patients'
}

/** The dictionary's own key expression, or a hash of the code when it has none. */
function conceptIdExpr(source: ProfileSource): string {
  const dict = source.dictionary
  return dict.idColumn
    ? `d."${dict.idColumn}"`
    : `(hash(d."${dict.codeColumn ?? dict.nameColumn}") % 2147483647)::INTEGER`
}

/**
 * Records and patients per concept, for the whole dictionary at once.
 *
 * One GROUP BY over the event table instead of one COUNT per concept: the same
 * scan either way, but paid once. Only run when the chosen sort needs it —
 * ordering by code costs nothing, and making every extraction wait for a full
 * table scan to start would be a poor trade.
 *
 * Concepts absent from the event table do not appear here; the caller ranks them
 * last, since a concept with no records is exactly what a volume sort defers.
 */
export function buildConceptCountsQuery(source: ProfileSource): string {
  const et = source.eventTable
  const patientCol = et.patientIdColumn
  // Both OMOP concept columns name the same concept, so a row reached through
  // either must count once — hence the coalesce rather than two groupings.
  const key = et.sourceConceptIdColumn
    ? `COALESCE(e."${et.conceptIdColumn}", e."${et.sourceConceptIdColumn}")`
    : `e."${et.conceptIdColumn}"`
  return `SELECT ${key} AS concept_id,
    COUNT(*) AS record_count,
    ${patientCol ? `COUNT(DISTINCT e."${patientCol}")` : 'NULL'} AS patient_count
  FROM "${et.table}" e
  WHERE ${key} IS NOT NULL
  GROUP BY ${key}`
}

/**
 * Every concept id in the dictionary, so a ranking can cover all of them.
 *
 * The counting pass only sees concepts the event table mentions; this is what
 * tells the ranking about the rest.
 */
export function buildDictionaryIdsQuery(source: ProfileSource): string {
  const idExpr = conceptIdExpr(source)
  return `SELECT ${idExpr} AS concept_id FROM "${source.dictionary.table}" d`
}

/** One concept's counts, as the counting pass returns them. */
export interface ConceptCounts {
  concept_id: number
  record_count: number
  patient_count: number | null
}

/**
 * The concept ids to walk, in the order the sort asks for.
 *
 * Returned as an explicit list rather than an ORDER BY because the counts live
 * in the event table, not the dictionary: the ranking is computed here, once,
 * and the pages then follow it.
 *
 * `allIds` is the whole dictionary. Every one of its concepts is ranked, not
 * just the ones the event table mentions: a concept with no records is still a
 * source concept and belongs in the CSV with a zero count. Ranking only the
 * counted ones silently dropped them — on MIMIC's demo that turned a 5,636
 * concept dictionary into 1,816.
 */
export function rankConceptIds(
  counts: ConceptCounts[],
  sort: ExtractionSort,
  allIds?: number[],
): number[] {
  const column = sort.key === 'patients' ? 'patient_count' : 'record_count'
  const sign = sort.direction === 'desc' ? -1 : 1
  const byId = new Map<number, number>()
  for (const row of counts) byId.set(Number(row.concept_id), Number(row[column] ?? 0))

  const ids = allIds ?? counts.map((row) => Number(row.concept_id))
  return [...ids].sort((a, b) => {
    const av = byId.get(a) ?? 0
    const bv = byId.get(b) ?? 0
    // Ties broken by id so the order is total: LIMIT/OFFSET over a partial
    // order would swap concepts between pages, extracting one twice and
    // another never. Record-less concepts all tie at 0, so they land together
    // at whichever end the direction puts them — last, when sorting desc.
    if (av !== bv) return sign * (av - bv)
    return a - b
  })
}

/**
 * One page of the dictionary, in a stable order.
 *
 * Paging with LIMIT/OFFSET is only a stable window over a TOTAL order, so every
 * sort here ends in the concept key: two concepts sharing a name would otherwise
 * swap between pages — one extracted twice, another never.
 *
 * The id expression falls back to a hash of the code when the dictionary has no
 * key column, the same expression `buildConceptUnionParts` uses, so a concept
 * keeps one id across the source view and the extraction.
 *
 * `orderedIds` carries a ranking computed elsewhere (the volume sorts); the page
 * is then the slice of that list, fetched by id.
 */
export function buildDictionaryPageQuery(
  source: ProfileSource,
  limit: number,
  offset: number,
  // Key order, not the UI's default: with no sort passed, the only safe order is
  // the one that needs no ranking and is guaranteed total.
  sort: ExtractionSort = KEY_ORDER,
  orderedIds?: number[],
): string {
  const dict = source.dictionary
  const idExpr = conceptIdExpr(source)
  const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn
  const select = `SELECT
    ${idExpr} AS concept_id,
    ${dict.codeColumn ? `CAST(d."${dict.codeColumn}" AS VARCHAR)` : `CAST(${idExpr} AS VARCHAR)`} AS concept_code,
    d."${dict.nameColumn}" AS concept_name,
    ${vocabCol ? `CAST(d."${vocabCol}" AS VARCHAR)` : `'${dict.table}'`} AS vocabulary_id,
    ${dict.categoryColumn ? `CAST(d."${dict.categoryColumn}" AS VARCHAR)` : 'NULL'} AS category
  FROM "${dict.table}" d`

  if (orderedIds) {
    // The ranking already IS the page: take its slice and fetch those concepts,
    // then restore the ranking's order, which an IN list does not preserve.
    const slice = orderedIds.slice(offset, offset + Math.trunc(limit))
    if (slice.length === 0) return ''
    const ids = slice.map((id) => Math.trunc(id)).join(', ')
    const positions = slice
      .map((id, i) => `WHEN ${Math.trunc(id)} THEN ${i}`)
      .join(' ')
    return `${select}
  WHERE ${idExpr} IN (${ids})
  ORDER BY CASE ${idExpr} ${positions} END`
  }

  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  const column = sort.key === 'name'
    ? `d."${dict.nameColumn}"`
    : sort.key === 'code' && dict.codeColumn
      ? `d."${dict.codeColumn}"`
      : idExpr
  const order = column === idExpr
    ? `${idExpr} ${direction}`
    : `${column} ${direction}, ${idExpr} ASC`
  return `${select}
  ORDER BY ${order}
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

/**
 * Reported after each concept so the UI can show progress within a batch.
 *
 * Carries the concept itself, not only the count: at fifty concepts a second the
 * number alone says nothing about WHERE the run is, and a reader who pauses on
 * it wants to know which concept is being profiled.
 */
export type ProgressFn = (
  extracted: number,
  total: number,
  concept: { conceptCode: string; conceptName: string },
) => void

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
  // Key order, not the UI's default: with no sort passed, the only safe order is
  // the one that needs no ranking and is guaranteed total.
  sort: ExtractionSort = KEY_ORDER,
  orderedIds?: number[],
): Promise<BatchResult> {
  const sql = buildDictionaryPageQuery(source, batchSize, offset, sort, orderedIds)
  // An empty ranking slice means the ranked list is exhausted — there is no
  // query to run, and asking for one would return the whole dictionary.
  if (!sql) return { rows: [], nextOffset: offset, done: true }
  const page = await query(sql)
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

    const conceptCode = concept.concept_code == null ? '' : String(concept.concept_code)
    rows.push({
      terminology: concept.vocabulary_id ?? '',
      concept_code: conceptCode,
      concept_id: conceptId,
      concept_name: conceptName,
      category: concept.category ?? '',
      record_count: profile.rowsCount,
      patient_count: profile.patientsCount,
      // An empty cell, not "null": the source view parses this column as JSON and
      // treats anything unparseable as absent, which is what a withheld profile is.
      info_json: profile.json ? JSON.stringify(profile.json) : '',
    })
    onProgress?.(offset + rows.length, total, { conceptCode, conceptName })
  }

  const nextOffset = offset + rows.length
  // Short page means the dictionary is exhausted — but only if the batch ran to
  // completion. An aborted batch is short for a different reason, and calling it
  // done would strand the rest of the dictionary.
  //
  // A ranked run compares against the slice it asked for, not the batch size:
  // the ranking can hold fewer concepts than the dictionary (a concept with no
  // records never appears in the counts), so a full slice can still be short.
  const asked = orderedIds
    ? Math.min(batchSize, Math.max(0, orderedIds.length - offset))
    : batchSize
  const done = !signal?.aborted && page.length < asked
  return { rows, nextOffset, done }
}
