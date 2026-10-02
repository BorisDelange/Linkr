import type { SchemaMapping } from '@/types/schema-mapping'
import { conceptRelations, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { escSql as esc } from '@/lib/format-helpers'
import { buildFuzzySearchSql, type FuzzySearchSql } from '@/lib/fuzzy-search'

// ---------------------------------------------------------------------------
// Column descriptors
// ---------------------------------------------------------------------------

export interface ColumnDescriptor {
  /** Stable alias used in ConceptRow keys and TanStack column IDs. */
  id: string
  /** Source: 'core' (id/name), 'code', 'vocabulary', 'extra', 'dict', 'computed'.
   *  'conceptSet' is joined in client-side from imported data dictionaries. */
  source: 'core' | 'code' | 'vocabulary' | 'extra' | 'dict' | 'computed' | 'conceptSet'
  /** Whether a dropdown filter should be generated (few distinct values). */
  filterable: boolean
}

/** OMOP validity metadata, ordered as they sit at the end of the table. */
export const VALIDITY_COLUMNS = ['valid_start_date', 'valid_end_date', 'invalid_reason']

/**
 * Columns joined in from the workspace's imported data dictionaries, matched on
 * (vocabulary_id, concept_code). They are computed in the browser — the sets are
 * not in the source database — so they are filtered client-side, unlike every
 * other column here.
 */
export const CONCEPT_SET_COLUMNS = [
  'concept_set_name',
  'concept_set_category',
  'concept_set_subcategory',
]

/** Columns the table hides until the user opts in via the column picker. The
 *  validity trio is rarely consulted while browsing, and the data-dictionary
 *  columns are only meaningful once a dictionary has been imported. */
export const DEFAULT_HIDDEN_COLUMNS = [...VALIDITY_COLUMNS, ...CONCEPT_SET_COLUMNS]

/**
 * Compute the union of all columns across multiple concept dictionaries.
 * Returns stable column descriptors that drive the table, filters, and sort.
 */
export function computeAvailableColumns(dicts: readonly ClassRelation[]): ColumnDescriptor[] {
  // Order mirrors the conventional concept layout:
  // vocabulary_id, concept_id, concept_name, concept_code, domain_id,
  // concept_class_id, [other extras], standard_concept, then counts last.
  const cols: ColumnDescriptor[] = []

  // Which dictionary the row came from — the same "what terminology is this?"
  // role vocabulary_id plays, so it sits alongside it. Multi-dict sources only.
  if (dicts.length > 1) {
    cols.push({ id: '_dict_key', source: 'dict', filterable: true })
  }
  if (dicts.some((d) => has(d, 'terminology_id'))) {
    cols.push({ id: 'vocabulary_id', source: 'vocabulary', filterable: true })
  }
  cols.push({ id: 'concept_id', source: 'core', filterable: false })
  cols.push({ id: 'concept_name', source: 'core', filterable: false })
  if (dicts.some((d) => has(d, 'concept_code'))) {
    cols.push({ id: 'concept_code', source: 'code', filterable: false })
  }
  if (dicts.some((d) => has(d, 'category'))) {
    cols.push({ id: 'domain_id', source: 'extra', filterable: true })
  }
  if (dicts.some((d) => has(d, 'subcategory'))) {
    cols.push({ id: 'concept_class_id', source: 'extra', filterable: true })
  }

  // Union of all extraColumns keys across all dicts, skipping any already
  // emitted above. standard_concept is held back to sit last (before counts),
  // and the OMOP validity trio is pushed past the counts (see below).
  const alreadyEmitted = new Set(cols.map((c) => c.id))
  const extraKeys = new Set<string>()
  let hasStandardConcept = false
  for (const d of dicts) {
    if (d.extras) {
      for (const key of Object.keys(d.extras)) {
        if (alreadyEmitted.has(key)) continue
        if (key === 'standard_concept') { hasStandardConcept = true; continue }
        if (VALIDITY_COLUMNS.includes(key)) continue
        extraKeys.add(key)
      }
    }
  }
  for (const key of extraKeys) {
    cols.push({ id: key, source: 'extra', filterable: true })
  }
  if (hasStandardConcept) {
    cols.push({ id: 'standard_concept', source: 'extra', filterable: true })
  }

  // OMOP validity trio — rarely-consulted metadata, hidden by default.
  const hasValidity = new Set<string>()
  for (const d of dicts) {
    for (const key of Object.keys(d.extras ?? {})) {
      if (VALIDITY_COLUMNS.includes(key)) hasValidity.add(key)
    }
  }
  for (const key of VALIDITY_COLUMNS) {
    if (hasValidity.has(key)) cols.push({ id: key, source: 'extra', filterable: key === 'invalid_reason' })
  }

  // Data-dictionary columns, joined on (vocabulary_id, concept_code). Only
  // offered when the source has both keys — without them nothing can match.
  const canJoinConceptSets =
    cols.some((c) => c.id === 'vocabulary_id') && cols.some((c) => c.id === 'concept_code')
  if (canJoinConceptSets) {
    for (const id of CONCEPT_SET_COLUMNS) {
      cols.push({ id, source: 'conceptSet', filterable: true })
    }
  }

  // Computed counts sit last, patients before rows.
  cols.push({ id: 'patient_count', source: 'computed', filterable: false })
  cols.push({ id: 'record_count', source: 'computed', filterable: false })

  return cols
}

// ---------------------------------------------------------------------------
// Filters (generic)
// ---------------------------------------------------------------------------

/**
 * Generic filters: key = column alias, value = filter value (null = no filter).
 * Column dropdowns hold a string[] (multi-select, empty = no filter); the
 * `_search*` keys hold a single string.
 * Special keys: 'searchText' (fuzzy name), 'searchId' (ID prefix), 'searchCode' (code ILIKE).
 */
export type ConceptFilterValue = string | string[] | null
export type ConceptFilters = Record<string, ConceptFilterValue>

/** Sentinel option standing for SQL NULL — OMOP leaves standard_concept NULL on
 *  non-standard concepts, so "NS" has to be selectable like any other value. */
export const NULL_FILTER_VALUE = '__null__'

/** Read a filter that is always single-valued (the `_search*` keys). */
function filterText(value: ConceptFilterValue): string | null {
  return typeof value === 'string' ? value : null
}

/** Read any filter as the list of selected values (empty = no filter). */
function filterValues(value: ConceptFilterValue): string[] {
  if (Array.isArray(value)) return value.filter(Boolean)
  return value ? [value] : []
}

/** SQL predicate for one column against selected values, honouring the NULL
 *  sentinel. Returns null when nothing is selected. */
function filterCondition(quotedCol: string, values: string[]): string | null {
  if (values.length === 0) return null
  const nonNull = values.filter((v) => v !== NULL_FILTER_VALUE)
  const parts: string[] = []
  if (nonNull.length === 1) {
    parts.push(`${quotedCol} = '${esc(nonNull[0])}'`)
  } else if (nonNull.length > 1) {
    parts.push(`${quotedCol} IN (${nonNull.map((v) => `'${esc(v)}'`).join(', ')})`)
  }
  if (values.length !== nonNull.length) parts.push(`${quotedCol} IS NULL`)
  return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]
}

export const EMPTY_FILTERS: ConceptFilters = {}

/** Relevance ranking over the *output* aliases (concept_name / concept_code /
 *  concept_id), usable in an outer ORDER BY where the dict's raw column names
 *  are no longer in scope. Null when the toolbar search is empty. */
function aliasedFuzzyRank(filters: ConceptFilters, allColumns: ColumnDescriptor[]): string | null {
  const term = filterText(filters._searchFuzzy)
  if (!term?.trim()) return null
  // No code column in the output (MIMIC d_items) means no code to rank on:
  // naming it anyway made the whole search fail to bind.
  return buildFuzzySearchSql(term, {
    nameColumn: 'concept_name',
    codeColumn: allColumns.some((c) => c.id === 'concept_code') ? 'concept_code' : undefined,
    idColumn: 'concept_id',
  })?.rankExpr ?? null
}

/** Fuzzy-search clauses for a dictionary relation, or null when the toolbar search is empty. */
function fuzzyClause(
  dict: ClassRelation,
  filters: ConceptFilters,
  alias?: string,
): FuzzySearchSql | null {
  const term = filterText(filters._searchFuzzy)
  if (!term?.trim()) return null
  return buildFuzzySearchSql(term, {
    nameColumn: 'concept_name',
    codeColumn: has(dict, 'concept_code') ? 'concept_code' : undefined,
    idColumn: 'concept_id',
    alias,
  })
}

function buildWhereClause(dict: ClassRelation, filters: ConceptFilters, allColumns: ColumnDescriptor[], alias?: string): string {
  const p = alias ? `${alias}.` : ''
  const conditions: string[] = []

  // Search by ID prefix
  const searchId = filterText(filters._searchId)
  if (searchId?.trim()) {
    conditions.push(`CAST(${p}concept_id AS TEXT) ILIKE '${esc(searchId.trim())}%'`)
  }

  // Search by name (multi-word fuzzy)
  const searchText = filterText(filters._searchText)
  if (searchText?.trim()) {
    const words = searchText.trim().split(/\s+/).filter(Boolean)
    const wordConditions = words.map((w) => `${p}concept_name ILIKE '%${esc(w)}%'`)
    conditions.push(words.length === 1 ? wordConditions[0] : `(${wordConditions.join(' AND ')})`)
  }

  // Search by code
  const searchCode = filterText(filters._searchCode)
  if (searchCode?.trim() && has(dict, 'concept_code')) {
    conditions.push(`${p}concept_code ILIKE '%${esc(searchCode.trim())}%'`)
  }

  // Toolbar fuzzy search — spans name/code/id with the shared tier ranking, so
  // a typo or a word order swap still finds the concept.
  const fuzzy = fuzzyClause(dict, filters, alias)
  if (fuzzy) conditions.push(fuzzy.where)

  // Dropdown filters on vocabulary / extra columns. Multi-select: several values
  // on one column are OR-ed (IN), different columns AND-ed.
  for (const col of allColumns) {
    if (!col.filterable) continue
    // Concept-set columns have no SQL counterpart; the table filters them.
    if (col.source === 'conceptSet') continue
    const values = filterValues(filters[col.id])
    if (values.length === 0) continue

    const actualCol = resolveActualColumn(dict, col.id)
    if (!actualCol) continue // column doesn't exist in this dict — skip

    const cond = filterCondition(`${p}"${actualCol}"`, values)
    if (cond) conditions.push(cond)
  }

  return conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export interface ConceptSorting {
  columnId: string
  desc: boolean
}

/** The contract column of a dictionary relation behind a table column id. */
function resolveActualColumn(dict: ClassRelation, columnId: string): string | null {
  const extra = (alias: string) => dict.extras?.[alias] ?? null
  switch (columnId) {
    case 'concept_id': return 'concept_id'
    case 'concept_name': return 'concept_name'
    case 'concept_code': return has(dict, 'concept_code') ? 'concept_code' : null
    case 'vocabulary_id': return has(dict, 'terminology_id') ? 'terminology_id' : null
    case 'domain_id': return has(dict, 'category') ? 'category' : extra('domain_id')
    case 'concept_class_id': return has(dict, 'subcategory') ? 'subcategory' : extra('concept_class_id')
    default: return extra(columnId)
  }
}

/** The event relations whose concepts this dictionary names. */
function eventsOf(mapping: SchemaMapping, dict: ClassRelation): ClassRelation[] {
  return eventRelations(mapping).filter((e) => e.dictionary === dict.name)
}

/** The dictionary relations to query, narrowed by the `_dict_key` filter. */
function activeDicts(mapping: SchemaMapping, filters: ConceptFilters): ClassRelation[] {
  const keys = filterValues(filters._dict_key)
  const dicts = conceptRelations(mapping)
  return keys.length ? dicts.filter((d) => keys.includes(d.key ?? '')) : dicts
}

// ---------------------------------------------------------------------------
// Counts subquery (aggregated record + patient counts from event tables)
// ---------------------------------------------------------------------------

/**
 * Where a dictionary's record / patient counts come from:
 * - `inline`: counted from the event tables in the query itself (front-only
 *   mode, where the warehouse is small enough);
 * - `units`: read from the counting units written so far, through the view the
 *   server's assemble step exposes. A phase not yet complete leaves NULL rather
 *   than 0 — "not counted yet" is not "never used";
 * - `none`: no counts (the detail of a single concept).
 */
export type CountsSource =
  | { kind: 'inline' }
  | { kind: 'units'; recordsComplete: boolean; patientsComplete: boolean }
  | { kind: 'none' }

/** The view `assemble` exposes the units through (`concept_cache_fs.COUNTS_VIEW`). */
export const CONCEPT_COUNTS_VIEW = 'memory.main._concept_counts'

/**
 * Build a counts subquery for a dictionary, aggregating record_count and patient_count
 * across all event tables linked to that dictionary.
 * Returns null if no event tables exist for the dictionary.
 */
function buildCountsSubquery(mapping: SchemaMapping, dict: ClassRelation): string | null {
  const parts: string[] = []
  for (const event of eventsOf(mapping, dict)) {
    parts.push(`SELECT concept_id AS cid, patient_id AS pid FROM ${event.name}`)
    // A source column repeating the standard one would count the row twice for that concept.
    if (has(event, 'source_concept_id')) {
      parts.push(`SELECT source_concept_id AS cid, patient_id AS pid FROM ${event.name} WHERE source_concept_id IS DISTINCT FROM concept_id`)
    }
  }
  if (parts.length === 0) return null

  return `(SELECT cid AS concept_id, COUNT(*)::INTEGER AS record_count, COUNT(DISTINCT pid)::INTEGER AS patient_count
  FROM (
    ${parts.join('\n    UNION ALL\n    ')}
  ) _evts
  GROUP BY cid)`
}

function buildUnitCountsSubquery(dict: ClassRelation): string {
  return `(SELECT concept_id, SUM(record_count)::BIGINT AS record_count, SUM(patient_count)::BIGINT AS patient_count
  FROM ${CONCEPT_COUNTS_VIEW}
  WHERE dict_key = '${esc(dict.key ?? '')}'
  GROUP BY concept_id)`
}

// ---------------------------------------------------------------------------
// Main queries: concepts list (supports multi-dict UNION ALL)
// ---------------------------------------------------------------------------

function buildSelectForDict(
  dict: ClassRelation,
  allColumns: ColumnDescriptor[],
  filters: ConceptFilters,
  mapping: SchemaMapping,
  counts: CountsSource,
  extraWhere?: string,
): string {
  const countsSubquery =
    counts.kind === 'inline' ? buildCountsSubquery(mapping, dict)
      : counts.kind === 'units' ? buildUnitCountsSubquery(dict)
        : null
  const hasCounts = countsSubquery !== null
  const countCol = (col: 'record_count' | 'patient_count', complete: boolean) =>
    complete ? `COALESCE(_counts.${col}, 0) AS ${col}` : `_counts.${col} AS ${col}`
  const filterWhere = buildWhereClause(dict, filters, allColumns, 'c')
  const where = extraWhere ? (filterWhere ? `${filterWhere} AND ${extraWhere}` : `WHERE ${extraWhere}`) : filterWhere

  const cols: string[] = ['c.concept_id', 'c.concept_name']

  for (const col of allColumns) {
    if (col.id === 'concept_id' || col.id === 'concept_name') continue
    // Joined in the browser from imported dictionaries — selecting them here
    // would emit NULL and shadow the values the table computes.
    if (col.source === 'conceptSet') continue
    if (col.source === 'dict') {
      cols.push(`'${esc(dict.key ?? '')}' AS _dict_key`)
      continue
    }
    if (col.id === 'record_count') {
      cols.push(hasCounts ? countCol('record_count', counts.kind !== 'units' || counts.recordsComplete) : '0 AS record_count')
      continue
    }
    if (col.id === 'patient_count') {
      cols.push(hasCounts ? countCol('patient_count', counts.kind !== 'units' || counts.patientsComplete) : '0 AS patient_count')
      continue
    }

    const actual = resolveActualColumn(dict, col.id)
    cols.push(actual ? `c."${actual}" AS "${col.id}"` : `NULL AS "${col.id}"`)
  }

  const joinClause = hasCounts ? `LEFT JOIN ${countsSubquery} _counts ON c.concept_id = _counts.concept_id` : ''

  return `SELECT ${cols.join(', ')} FROM ${dict.name} c ${joinClause} ${where}`
}

export function buildConceptsQuery(
  mapping: SchemaMapping,
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
  page: number,
  pageSize: number,
  sorting?: ConceptSorting | null,
): string | null {
  const dicts = activeDicts(mapping, filters)
  if (dicts.length === 0) return null
  const offset = page * pageSize
  const subQueries = dicts.map((d) => buildSelectForDict(d, allColumns, filters, mapping, { kind: 'inline' }))

  // ORDER BY — all columns including record_count and patient_count. An explicit
  // sort wins; otherwise a fuzzy search orders by relevance (best tier first).
  let orderBy = 'concept_id'
  if (sorting) {
    orderBy = `"${sorting.columnId}" ${sorting.desc ? 'DESC' : 'ASC'}`
  } else if (aliasedFuzzyRank(filters, allColumns)) {
    orderBy = `${aliasedFuzzyRank(filters, allColumns)}, concept_name`
  }

  if (subQueries.length === 1) {
    return `SELECT * FROM (${subQueries[0]}) _q ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
  }

  // Multi-dict: wrap in subquery for ORDER BY + LIMIT
  return `SELECT * FROM (
  ${subQueries.join('\n  UNION ALL\n  ')}
) _union ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
}

/** The full (unpaginated, unfiltered) enriched list, its counts read from the
 * counting units done so far — the SELECT the server's assemble step writes to
 * the Parquet cache. Its output columns are the stable aliases the cache page
 * queries then read. */
export function buildConceptsAssembleQuery(
  mapping: SchemaMapping,
  allColumns: ColumnDescriptor[],
  progress: { recordsComplete: boolean; patientsComplete: boolean },
): string | null {
  const counts: CountsSource = { kind: 'units', ...progress }
  const subQueries = conceptRelations(mapping).map((d) => buildSelectForDict(d, allColumns, EMPTY_FILTERS, mapping, counts))
  if (subQueries.length === 0) return null
  return subQueries.join('\n  UNION ALL\n  ')
}

export function buildConceptsCountQuery(
  mapping: SchemaMapping,
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
): string | null {
  const dicts = activeDicts(mapping, filters)
  if (dicts.length === 0) return null
  const parts = dicts.map((dict) => `SELECT COUNT(*)::INTEGER AS cnt FROM ${dict.name} ${buildWhereClause(dict, filters, allColumns)}`)
  if (parts.length === 1) return parts[0]
  return `SELECT SUM(cnt)::INTEGER AS cnt FROM (${parts.join(' UNION ALL ')}) _counts`
}

// ---------------------------------------------------------------------------
// Filter options (distinct values for dropdown columns)
// ---------------------------------------------------------------------------

export function buildFilterOptionsQuery(
  mapping: SchemaMapping,
  columnId: string,
): string | null {
  // Collect distinct values across all dicts that have this column
  const parts: string[] = []
  for (const dict of conceptRelations(mapping)) {
    const actual = resolveActualColumn(dict, columnId)
    if (actual) {
      parts.push(`SELECT DISTINCT "${actual}" AS val FROM ${dict.name} WHERE "${actual}" IS NOT NULL`)
    }
  }

  if (parts.length === 0) return null
  if (parts.length === 1) return `${parts[0]} ORDER BY val`
  return `SELECT DISTINCT val FROM (${parts.join(' UNION ALL ')}) _opts ORDER BY val`
}

// ---------------------------------------------------------------------------
// Queries against the materialized flat Parquet cache (server mode)
//
// The cache is one row per concept with the stable alias columns
// (concept_id, concept_name, record_count, …), exposed server-side as the view
// `concepts`. Filters/sort/search are therefore plain single-table predicates on
// those aliases — much simpler than the source multi-table SQL.
// ---------------------------------------------------------------------------

/** WHERE clause over the flat cache columns (mirrors buildWhereClause's filters
 * but against the stable aliases, single table). */
function buildCacheWhere(filters: ConceptFilters, allColumns: ColumnDescriptor[]): string {
  const conditions: string[] = []

  const searchId = filterText(filters._searchId)
  if (searchId?.trim()) {
    conditions.push(`CAST("concept_id" AS TEXT) ILIKE '${esc(searchId.trim())}%'`)
  }

  const searchText = filterText(filters._searchText)
  if (searchText?.trim()) {
    const words = searchText.trim().split(/\s+/).filter(Boolean)
    const parts = words.map((w) => `"concept_name" ILIKE '%${esc(w)}%'`)
    if (parts.length) conditions.push(`(${parts.join(' AND ')})`)
  }

  const searchCode = filterText(filters._searchCode)
  if (searchCode?.trim()) {
    conditions.push(`"concept_code" ILIKE '%${esc(searchCode.trim())}%'`)
  }

  // Toolbar fuzzy search over the cache's stable aliases.
  const fuzzyTerm = filterText(filters._searchFuzzy)
  if (fuzzyTerm?.trim()) {
    const fz = buildFuzzySearchSql(fuzzyTerm, {
      nameColumn: 'concept_name',
      codeColumn: allColumns.some((c) => c.id === 'concept_code') ? 'concept_code' : undefined,
      idColumn: 'concept_id',
    })
    if (fz) conditions.push(fz.where)
  }

  const dictKeyCond = filterCondition('"_dict_key"', filterValues(filters._dict_key))
  if (dictKeyCond) conditions.push(dictKeyCond)

  for (const col of allColumns) {
    if (!col.filterable) continue
    if (col.id === '_dict_key') continue
    if (col.source === 'conceptSet') continue
    const cond = filterCondition(`"${col.id}"`, filterValues(filters[col.id]))
    if (cond) conditions.push(cond)
  }

  return conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
}

export function buildCachePageQuery(
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
  page: number,
  pageSize: number,
  sorting?: ConceptSorting | null,
): string {
  const where = buildCacheWhere(filters, allColumns)
  const rank = aliasedFuzzyRank(filters, allColumns)
  const orderBy = sorting
    ? `"${sorting.columnId}" ${sorting.desc ? 'DESC' : 'ASC'}`
    : rank
      ? `${rank}, concept_name`
      : 'concept_id'
  return `SELECT * FROM concepts ${where} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${page * pageSize}`
}

export function buildCacheCountQuery(
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
): string {
  return `SELECT COUNT(*)::INTEGER AS cnt FROM concepts ${buildCacheWhere(filters, allColumns)}`
}

export function buildCacheFilterOptionsQuery(columnId: string): string {
  return `SELECT DISTINCT "${columnId}" AS val FROM concepts WHERE "${columnId}" IS NOT NULL ORDER BY val`
}

export function buildCacheDetailQuery(conceptId: number): string {
  return `SELECT * FROM concepts WHERE concept_id = ${conceptId} LIMIT 1`
}

// ---------------------------------------------------------------------------
// Concept detail
// ---------------------------------------------------------------------------

/**
 * One concept's row, with the same columns as the list — which is also what the
 * server-mode detail reads from the materialized cache, so both modes show the
 * same fields.
 */
export function buildConceptFullQuery(
  mapping: SchemaMapping,
  conceptId: number,
  dictKey?: string,
): string | null {
  const dicts = conceptRelations(mapping).filter((d) => !dictKey || d.key === dictKey)
  if (dicts.length === 0) return null
  const columns = computeAvailableColumns(conceptRelations(mapping))
  const match = `c.concept_id = ${Number(conceptId)}`
  const parts = dicts.map((d) => buildSelectForDict(d, columns, EMPTY_FILTERS, mapping, { kind: 'none' }, match))
  return `${parts.join(' UNION ALL ')} LIMIT 1`
}

// ---------------------------------------------------------------------------
// Single concept count (for detail panel)
// ---------------------------------------------------------------------------

/** `concept_id = n`, or its source concept, for one event relation. */
function conceptMatch(event: ClassRelation, conceptId: number): string {
  const id = Number(conceptId)
  return has(event, 'source_concept_id') ? `concept_id = ${id} OR source_concept_id = ${id}` : `concept_id = ${id}`
}

function dictByKey(mapping: SchemaMapping, dictKey: string): ClassRelation | undefined {
  return conceptRelations(mapping).find((d) => d.key === dictKey)
}

export function buildDomainCountQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
): string | null {
  const dict = dictByKey(mapping, dictKey)
  const events = dict ? eventsOf(mapping, dict) : []
  if (events.length === 0) return null

  // Sum across all event tables for this dict
  const parts = events.map((e) => `SELECT COUNT(*)::INTEGER AS cnt FROM ${e.name} WHERE ${conceptMatch(e, conceptId)}`)
  if (parts.length === 1) return parts[0]
  return `SELECT SUM(cnt)::INTEGER AS cnt FROM (${parts.join(' UNION ALL ')}) _counts`
}

// ---------------------------------------------------------------------------
// Value distribution & histogram (unchanged logic, generic interface)
// ---------------------------------------------------------------------------

/** Event relations of a dictionary that record a numeric value. */
function valuedEvents(mapping: SchemaMapping, dictKey: string): ClassRelation[] {
  const dict = dictByKey(mapping, dictKey)
  return dict ? eventsOf(mapping, dict).filter((e) => has(e, 'value_number')) : []
}

/**
 * The concept's values, gathered from EVERY event table of the dictionary that
 * records one.
 *
 * A dictionary usually spans several tables (measurement, observation…), and
 * which of them holds a given concept is a property of the data, not of the
 * mapping. Reading only the first one that declares a value reported "0
 * non-null values" and empty min/max/mean for every concept living in another
 * table.
 */
function valueSourceUnion(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
): string | null {
  const parts = valuedEvents(mapping, dictKey).map(
    (e) => `SELECT value_number AS v FROM ${e.name} WHERE (${conceptMatch(e, conceptId)}) AND value_number IS NOT NULL`,
  )
  return parts.length === 0 ? null : parts.join(' UNION ALL ')
}

export function buildValueDistributionQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
): string | null {
  const union = valueSourceUnion(mapping, dictKey, conceptId)
  if (!union) return null

  return `WITH vals AS (
  ${union}
)
SELECT
  COUNT(*)::INTEGER AS total_count,
  COUNT(v)::INTEGER AS non_null_count,
  ROUND(MIN(v)::NUMERIC, 2)::DOUBLE AS min_val,
  ROUND(MAX(v)::NUMERIC, 2)::DOUBLE AS max_val,
  ROUND(AVG(v)::NUMERIC, 2)::DOUBLE AS mean_val,
  ROUND(MEDIAN(v)::NUMERIC, 2)::DOUBLE AS median_val,
  ROUND(STDDEV(v)::NUMERIC, 2)::DOUBLE AS std_val,
  ROUND(QUANTILE_CONT(v, 0.25)::NUMERIC, 2)::DOUBLE AS q1_val,
  ROUND(QUANTILE_CONT(v, 0.75)::NUMERIC, 2)::DOUBLE AS q3_val
FROM vals`
}

export function buildValueHistogramQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
  binCount = 20,
  excludeOutliers = true,
): string | null {
  const union = valueSourceUnion(mapping, dictKey, conceptId)
  if (!union) return null

  // Bin edges derive from the min/max of the plotted range, so a single absurd
  // value (a respiratory rate of 100000) would collapse every real value into
  // one bar. Clipping to P1–P99 in SQL — before the edges are computed — keeps
  // the bins over the real distribution. `excluded` reports what was dropped so
  // the panel can say so rather than silently hiding data.
  const stats = excludeOutliers
    ? `SELECT QUANTILE_CONT(v, 0.01) AS mn, QUANTILE_CONT(v, 0.99) AS mx FROM vals`
    : `SELECT MIN(v) AS mn, MAX(v) AS mx FROM vals`

  const rangeFilter = excludeOutliers ? ' AND v BETWEEN stats.mn AND stats.mx' : ''

  return `WITH vals AS (
  ${union}
), stats AS (
  ${stats}
), excluded AS (
  SELECT COUNT(*)::INTEGER AS n
  FROM vals, stats
  WHERE ${excludeOutliers ? '(v < stats.mn OR v > stats.mx)' : 'FALSE'}
)
SELECT
  ROUND((FLOOR((v - stats.mn) / NULLIF((stats.mx - stats.mn) / ${binCount}.0, 0)) * ((stats.mx - stats.mn) / ${binCount}.0) + stats.mn)::NUMERIC, 2)::DOUBLE AS bin_start,
  COUNT(*)::INTEGER AS count,
  ANY_VALUE(excluded.n) AS excluded_count
FROM vals, stats, excluded
WHERE TRUE${rangeFilter}
GROUP BY 1
ORDER BY 1`
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Whether any event table of a dictionary records a numeric value. */
export function hasValueColumnForDict(mapping: SchemaMapping, dictKey: string): boolean {
  return valuedEvents(mapping, dictKey).length > 0
}
