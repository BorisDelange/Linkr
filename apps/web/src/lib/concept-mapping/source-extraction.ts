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
  eventConceptKey,
  type ProfileOptions,
  type ProfileSource,
} from './concept-profile'
import { csvEscape } from './export'
import { escSql } from '@/lib/format-helpers'
import { has } from '@/lib/schema-classes/relations'

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

/** Whether a run computes anything beyond the dictionary's own columns. */
export function computesMetadata(options: ProfileOptions): boolean {
  return options.metadata !== false
}

/** Whether a run fills the record and patient counts. */
export function computesCounts(options: ProfileOptions): boolean {
  return computesMetadata(options) && options.sections.counts !== false
}

/**
 * The column mapping for a run's options. The CSV keeps every column (a
 * contract, see EXTRACTION_COLUMNS), but a column the run leaves empty is not
 * mapped: the source view would read an empty count as zero records.
 */
export function extractionColumnMapping(options: ProfileOptions): FileColumnMapping {
  const mapping = { ...EXTRACTION_COLUMN_MAPPING }
  if (!computesCounts(options)) {
    delete mapping.recordCountColumn
    delete mapping.patientCountColumn
  }
  if (!computesMetadata(options)) delete mapping.infoJsonColumn
  return mapping
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
  record_count: number | null
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
  // The same rows the unranked page query walks, or the run would count towards
  // concepts it never reaches.
  return `SELECT COUNT(*) AS total FROM ${source.dict.name} d WHERE ${namesAConcept(conceptIdExpr(source))}`
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
  return dict.ownId
    ? 'd.concept_id'
    : `(hash(d.${dict.hasCode ? 'concept_code' : 'concept_name'}) % 2147483647)::INTEGER`
}

/**
 * Whether an id expression names a concept.
 *
 * NULL is no concept, and neither is 0: OMOP's "No matching concept", the id of
 * every unmapped record, which a volume ranking put first and profiled with the
 * largest scan of the run. TRY_CAST so a text id column is compared as text
 * would be, rather than failing the run on its first non-numeric code.
 */
function namesAConcept(idExpr: string): string {
  return `${idExpr} IS NOT NULL AND TRY_CAST(${idExpr} AS BIGINT) IS DISTINCT FROM 0`
}

/**
 * Records and patients per concept in one event table, for the whole dictionary
 * at once.
 *
 * One GROUP BY over the event table instead of one COUNT per concept: the same
 * scan either way, but paid once. Only run when the run needs it — a volume
 * sort, keeping only concepts with records, or a dictionary spread over several
 * event tables — since ordering by code costs nothing, and making every
 * extraction wait for a full table scan to start would be a poor trade.
 *
 * Concepts absent from the event table do not appear here; the caller ranks them
 * last, since a concept with no records is exactly what a volume sort defers.
 */
export function buildConceptCountsQuery(source: ProfileSource, event = source.event): string {
  const patient = has(event, 'patient_id') ? 'COUNT(DISTINCT patient_id)' : 'NULL'
  const patientCol = has(event, 'patient_id') ? ', e.patient_id' : ''
  // A row counts for every concept it names — what the profile's
  // `concept_id = X OR source_concept_id = X` match counts — and once for a
  // concept named by both columns. Not a coalesce: an unmapped OMOP row carries
  // concept_id 0, not NULL, so its source concept, the very one to map, got
  // none of its records. One scan, unnested, rather than a UNION of two.
  const ids = has(event, 'source_concept_id')
    ? 'UNNEST(CASE WHEN e.source_concept_id IS DISTINCT FROM e.concept_id '
      + 'THEN [e.concept_id, e.source_concept_id] ELSE [e.concept_id] END)'
    : 'e.concept_id'
  // A code-only dictionary's id is a hash of its code (conceptIdExpr), and the
  // event table names the concept by that code: hashed the same way, or no count
  // would ever meet its concept and "only with records" dropped the dictionary.
  const raw = 'named.concept_id'
  const key = eventConceptKey(source.dictionary, raw)
  const where = source.dictionary.ownId ? namesAConcept(raw) : `${raw} IS NOT NULL`
  return `SELECT ${key} AS concept_id,
    COUNT(*) AS record_count,
    ${patient} AS patient_count
  FROM (SELECT ${ids} AS concept_id${patientCol} FROM ${event.name} e) AS named
  WHERE ${where}
  GROUP BY 1`
}

/**
 * Every concept id in the dictionary, so a ranking can cover all of them.
 *
 * The counting pass only sees concepts the event table mentions; this is what
 * tells the ranking about the rest. Given a sort the dictionary orders by on its
 * own (code, name, id), each id carries its position in that order as `ord`:
 * server mode reads this through a pager that re-sorts every page `ORDER BY
 * ALL` (it needs a total order to page stably), so an outer ORDER BY would come
 * back id-ascending whatever the user picked. Read it with `dictionaryWalkIds`.
 */
export function buildDictionaryIdsQuery(source: ProfileSource, sort?: ExtractionSort): string {
  const idExpr = conceptIdExpr(source)
  // One row per id because the id is not always the dictionary's own key: with
  // no key column it is a hash of the code, and two rows can share one (the same
  // code under two vocabulary versions, or a plain collision). A duplicate would
  // make `sizes[i]` count a concept the page query — which fetches by `IN (ids)`
  // — returns only once, so the run could never reach that dictionary's end.
  // A row with no id is no concept: read back as a number it became 0, which on
  // OMOP is every unmapped record's id, so a phantom concept led the ranking and
  // its missing page row made the run stop early, thinking itself done.
  const where = `WHERE ${namesAConcept(idExpr)}`
  if (!sort || sortNeedsCounts(sort)) {
    return `SELECT DISTINCT ${idExpr} AS concept_id FROM ${source.dict.name} d ${where}`
  }
  // Same order as buildDictionaryPageQuery's, the id breaking ties.
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  const column = sort.key === 'name'
    ? 'd.concept_name'
    : sort.key === 'code' && source.dictionary.hasCode ? 'd.concept_code' : null
  if (!column) {
    return `SELECT concept_id, row_number() OVER (ORDER BY concept_id ${direction}) AS ord
  FROM (SELECT DISTINCT ${idExpr} AS concept_id FROM ${source.dict.name} d ${where}) AS ids`
  }
  return `SELECT concept_id, row_number() OVER (ORDER BY sort_key ${direction}, concept_id ASC) AS ord
  FROM (SELECT ${idExpr} AS concept_id, MIN(${column}) AS sort_key
    FROM ${source.dict.name} d ${where} GROUP BY 1) AS ids`
}

/**
 * The ids `buildDictionaryIdsQuery` returned, in walk order: by `ord` when the
 * query carried one, whatever order the rows arrived in.
 */
export function dictionaryWalkIds(rows: Record<string, unknown>[]): number[] {
  const ordered = rows.some((r) => r.ord != null)
    ? [...rows].sort((a, b) => Number(a.ord) - Number(b.ord))
    : rows
  return ordered
    .map((r) => Number(r.concept_id))
    .filter((id) => Number.isFinite(id) && id !== 0)
}

/**
 * Each concept's counts over all its event tables, and its home table — the one
 * holding most of its records, where it is profiled — as an index into
 * `source.events`.
 *
 * `perTable` is one counting pass per event table, in `events` order. Records
 * add up across tables: a row is one record wherever it lives, and the sum is
 * what the CSV writes (see extractBatch's `recordTotals`) and the ranking sorts
 * on. Patients do not — a patient present in two tables would be counted twice —
 * so `patient_count` is the home table's, a lower bound. A tie on records goes to
 * the richer table, which comes first.
 */
export function mergeTableCounts(perTable: ConceptCounts[][]): {
  counts: ConceptCounts[]
  homes: Map<number, number>
} {
  const best = new Map<number, { row: ConceptCounts; table: number; records: number }>()
  perTable.forEach((rows, table) => {
    for (const row of rows) {
      const id = Number(row.concept_id)
      if (!Number.isFinite(id) || id === 0) continue
      const records = Number(row.record_count ?? 0)
      const current = best.get(id)
      if (!current) {
        best.set(id, { row, table, records })
        continue
      }
      current.records += records
      if (records > Number(current.row.record_count ?? 0)) {
        current.row = row
        current.table = table
      }
    }
  })
  const counts: ConceptCounts[] = []
  const homes = new Map<number, number>()
  for (const [id, { row, table, records }] of best) {
    counts.push({ concept_id: id, record_count: records, patient_count: row.patient_count })
    homes.set(id, table)
  }
  return { counts, homes }
}

/**
 * The concept ids a run walks, in order.
 *
 * A volume sort ranks the dictionary on the counts; any other sort keeps the
 * order `dictionaryIds` came back in (see buildDictionaryIdsQuery).
 * `onlyWithRecords` then drops every concept the event table never mentions —
 * on an OMOP warehouse whose dictionary is the whole vocabulary, nearly all of
 * them — so the run ends after the last concept that has data.
 */
export function planConceptWalk(
  counts: ConceptCounts[],
  sort: ExtractionSort,
  dictionaryIds: number[],
  onlyWithRecords: boolean,
): number[] {
  const ids = dictionaryIds.filter((id) => id !== 0)
  const ordered = sortNeedsCounts(sort) ? rankConceptIds(counts, sort, ids) : ids
  if (!onlyWithRecords) return ordered
  const withRecords = new Set(
    counts.filter((row) => Number(row.record_count ?? 0) > 0).map((row) => Number(row.concept_id)),
  )
  return ordered.filter((id) => withRecords.has(id))
}

/**
 * Which concepts of a ranked walk are behind it, independent of their order.
 *
 * A resume is an offset into a ranking it recomputes, and the warehouse may
 * have changed in between: concepts gain records, the ranking scheme itself
 * changes with a release. Continuing at the offset is only safe when the first
 * `n` concepts of the new ranking are the ones already written; this is what
 * the stored run compares to tell. A sum and a xor of mixed ids, so it extends
 * batch by batch without keeping the list.
 */
export interface WalkFingerprint {
  n: number
  sum: number
  xor: number
}

export const EMPTY_WALK: WalkFingerprint = { n: 0, sum: 0, xor: 0 }

/** murmur3's 32-bit finaliser over both halves of the id. */
function mixId(id: number): number {
  let h = (Math.trunc(id) ^ Math.floor(id / 4294967296)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

export function extendWalk(walk: WalkFingerprint, ids: readonly number[]): WalkFingerprint {
  let { n, sum, xor } = walk
  for (const id of ids) {
    const h = mixId(id)
    n++
    sum = (sum + h) >>> 0
    xor = (xor ^ h) >>> 0
  }
  return { n, sum, xor }
}

export function walkKey(walk: WalkFingerprint): string {
  return `${walk.n}:${walk.sum.toString(16)}:${walk.xor.toString(16)}`
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
 * key column, the same expression `sourceConceptKeyExprs` (mapping-queries) uses,
 * so a concept keeps one id across the generated ETL and the extraction.
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
  const rel = source.dict
  const idExpr = conceptIdExpr(source)
  // The table name stands in for a missing vocabulary: it is half of the
  // (vocabulary, code) identity mappings are keyed on.
  const select = `SELECT
    ${idExpr} AS concept_id,
    ${dict.hasCode ? 'CAST(d.concept_code AS VARCHAR)' : `CAST(${idExpr} AS VARCHAR)`} AS concept_code,
    d.concept_name AS concept_name,
    ${has(rel, 'terminology_id') ? 'CAST(d.terminology_id AS VARCHAR)' : `'${escSql(dict.table)}'`} AS vocabulary_id,
    ${has(rel, 'category') ? 'CAST(d.category AS VARCHAR)' : 'NULL'} AS category
  FROM ${rel.name} d`

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
    ? 'd.concept_name'
    : sort.key === 'code' && dict.hasCode
      ? 'd.concept_code'
      : idExpr
  const order = column === idExpr
    ? `${idExpr} ${direction}`
    : `${column} ${direction}, ${idExpr} ASC`
  // The rows buildDictionaryCountQuery sized, and the ones a ranked walk keeps.
  return `${select}
  WHERE ${namesAConcept(idExpr)}
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
  /** Concept id → index into `source.events` of the table to profile it in. */
  homes?: Map<number, number>,
  /**
   * Concept id → its records over every event table (mergeTableCounts). The
   * profile counts only the home table, which understates a concept spread
   * over several; patients stay the profile's, since they do not add up.
   */
  recordTotals?: Map<number, number>,
): Promise<BatchResult> {
  const sql = buildDictionaryPageQuery(source, batchSize, offset, sort, orderedIds)
  // An empty ranking slice means the ranked list is exhausted — there is no
  // query to run, and asking for one would return the whole dictionary.
  if (!sql) return { rows: [], nextOffset: offset, done: true }
  let page: Record<string, unknown>[]
  try {
    page = await query(sql)
  } catch (err) {
    if (signal?.aborted) return { rows: [], nextOffset: offset, done: false }
    throw err
  }
  if (page.length === 0) return { rows: [], nextOffset: offset, done: true }

  const metadata = computesMetadata(options)
  const counts = computesCounts(options)
  const rows: ExtractedConcept[] = []
  for (const raw of page) {
    if (signal?.aborted) break
    const concept = raw as unknown as DictionaryConcept
    const conceptId = Number(concept.concept_id)
    const conceptName = concept.concept_name == null ? '' : String(concept.concept_name)

    const home = source.events[homes?.get(conceptId) ?? 0] ?? source.event
    const profile = metadata
      ? await buildConceptProfile(
        mapping, home === source.event ? source : { ...source, event: home },
        { conceptId, conceptName, category: concept.category ?? undefined },
        options, query,
      )
      : null
    // A pause abandons the concept in flight: its queries were cut short, so
    // its profile is incomplete. The resume profiles it again.
    if (signal?.aborted) break

    const conceptCode = concept.concept_code == null ? '' : String(concept.concept_code)
    rows.push({
      terminology: concept.vocabulary_id ?? '',
      concept_code: conceptCode,
      concept_id: conceptId,
      concept_name: conceptName,
      category: concept.category ?? '',
      record_count: counts && profile ? (recordTotals?.get(conceptId) ?? profile.rowsCount) : null,
      patient_count: counts && profile ? profile.patientsCount : null,
      // An empty cell, not "null": the source view parses this column as JSON and
      // treats anything unparseable as absent, which is what a withheld profile is.
      info_json: profile?.json ? JSON.stringify(profile.json) : '',
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
