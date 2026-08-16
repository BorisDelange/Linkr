import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import {
  getEventTablesForDictionary,
  buildConceptMatchCondition,
} from '@/lib/schema-helpers'
import { escSql as esc } from '@/lib/format-helpers'
import { buildFuzzySearchSql, type FuzzySearchSql } from '@/lib/fuzzy-search'

// ---------------------------------------------------------------------------
// Column descriptors
// ---------------------------------------------------------------------------

export interface ColumnDescriptor {
  /** Stable alias used in ConceptRow keys and TanStack column IDs. */
  id: string
  /** Source: 'core' (id/name), 'code', 'vocabulary', 'extra', 'dict', 'computed'. */
  source: 'core' | 'code' | 'vocabulary' | 'extra' | 'dict' | 'computed'
  /** Whether a dropdown filter should be generated (few distinct values). */
  filterable: boolean
}

/** OMOP validity metadata, ordered as they sit at the end of the table. */
export const VALIDITY_COLUMNS = ['valid_start_date', 'valid_end_date', 'invalid_reason']

/** Columns the table hides until the user opts in via the column picker. The
 *  whole validity trio is rarely consulted while browsing concepts. */
export const DEFAULT_HIDDEN_COLUMNS = VALIDITY_COLUMNS

/**
 * Compute the union of all columns across multiple concept dictionaries.
 * Returns stable column descriptors that drive the table, filters, and sort.
 */
export function computeAvailableColumns(dicts: ConceptDictionary[]): ColumnDescriptor[] {
  // Order mirrors the conventional concept layout:
  // vocabulary_id, concept_id, concept_name, concept_code, domain_id,
  // concept_class_id, [other extras], standard_concept, then counts last.
  const cols: ColumnDescriptor[] = []

  if (dicts.some((d) => d.terminologyIdColumn || d.vocabularyColumn)) {
    cols.push({ id: 'vocabulary_id', source: 'vocabulary', filterable: true })
  }
  cols.push({ id: 'concept_id', source: 'core', filterable: false })
  cols.push({ id: 'concept_name', source: 'core', filterable: false })
  if (dicts.some((d) => d.codeColumn)) {
    cols.push({ id: 'concept_code', source: 'code', filterable: false })
  }
  if (dicts.some((d) => d.categoryColumn)) {
    cols.push({ id: 'domain_id', source: 'extra', filterable: true })
  }
  if (dicts.some((d) => d.subcategoryColumn)) {
    cols.push({ id: 'concept_class_id', source: 'extra', filterable: true })
  }

  // Union of all extraColumns keys across all dicts, skipping any already
  // emitted above. standard_concept is held back to sit last (before counts),
  // and the OMOP validity trio is pushed past the counts (see below).
  const alreadyEmitted = new Set(cols.map((c) => c.id))
  const extraKeys = new Set<string>()
  let hasStandardConcept = false
  for (const d of dicts) {
    if (d.extraColumns) {
      for (const key of Object.keys(d.extraColumns)) {
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

  // _dict_key column only if multiple dictionaries
  if (dicts.length > 1) {
    cols.push({ id: '_dict_key', source: 'dict', filterable: true })
  }

  // OMOP validity trio — rarely-consulted metadata, hidden by default.
  const hasValidity = new Set<string>()
  for (const d of dicts) {
    for (const key of Object.keys(d.extraColumns ?? {})) {
      if (VALIDITY_COLUMNS.includes(key)) hasValidity.add(key)
    }
  }
  for (const key of VALIDITY_COLUMNS) {
    if (hasValidity.has(key)) cols.push({ id: key, source: 'extra', filterable: key === 'invalid_reason' })
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
function aliasedFuzzyRank(filters: ConceptFilters): string | null {
  const term = filterText(filters._searchFuzzy)
  if (!term?.trim()) return null
  return buildFuzzySearchSql(term, {
    nameColumn: 'concept_name',
    codeColumn: 'concept_code',
    idColumn: 'concept_id',
  })?.rankExpr ?? null
}

/** Fuzzy-search clauses for a dict, or null when the toolbar search is empty. */
function fuzzyClause(
  dict: ConceptDictionary,
  filters: ConceptFilters,
  alias?: string,
): FuzzySearchSql | null {
  const term = filterText(filters._searchFuzzy)
  if (!term?.trim() || !dict.nameColumn) return null
  return buildFuzzySearchSql(term, {
    nameColumn: `"${dict.nameColumn}"`,
    codeColumn: dict.codeColumn ? `"${dict.codeColumn}"` : undefined,
    idColumn: dict.idColumn ? `"${dict.idColumn}"` : undefined,
    alias,
  })
}

function buildWhereClause(dict: ConceptDictionary, filters: ConceptFilters, allColumns: ColumnDescriptor[], alias?: string): string {
  const p = alias ? `${alias}.` : ''
  const conditions: string[] = []

  // Search by ID prefix
  const searchId = filterText(filters._searchId)
  if (searchId?.trim()) {
    conditions.push(`CAST(${p}"${dict.idColumn}" AS TEXT) ILIKE '${esc(searchId.trim())}%'`)
  }

  // Search by name (multi-word fuzzy)
  const searchText = filterText(filters._searchText)
  if (searchText?.trim() && dict.nameColumn) {
    const words = searchText.trim().split(/\s+/).filter(Boolean)
    if (words.length === 1) {
      conditions.push(`${p}"${dict.nameColumn}" ILIKE '%${esc(words[0])}%'`)
    } else {
      const wordConditions = words.map((w) => `${p}"${dict.nameColumn}" ILIKE '%${esc(w)}%'`)
      conditions.push(`(${wordConditions.join(' AND ')})`)
    }
  }

  // Search by code
  const searchCode = filterText(filters._searchCode)
  if (searchCode?.trim() && dict.codeColumn) {
    conditions.push(`${p}"${dict.codeColumn}" ILIKE '%${esc(searchCode.trim())}%'`)
  }

  // Toolbar fuzzy search — spans name/code/id with the shared tier ranking, so
  // a typo or a word order swap still finds the concept.
  const fuzzy = fuzzyClause(dict, filters, alias)
  if (fuzzy) conditions.push(fuzzy.where)

  // Dropdown filters on vocabulary / extra columns. Multi-select: several values
  // on one column are OR-ed (IN), different columns AND-ed.
  for (const col of allColumns) {
    if (!col.filterable) continue
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

/** Resolve a column alias to the actual SQL column name in a given dictionary. */
function resolveActualColumn(dict: ConceptDictionary, columnId: string): string | null {
  switch (columnId) {
    case 'concept_id': return dict.idColumn ?? null
    case 'concept_name': return dict.nameColumn
    case 'concept_code': return dict.codeColumn ?? null
    case 'vocabulary_id': return dict.terminologyIdColumn ?? dict.vocabularyColumn ?? null
    case 'domain_id': return dict.categoryColumn ?? dict.extraColumns?.domain_id ?? null
    case 'concept_class_id': return dict.subcategoryColumn ?? dict.extraColumns?.concept_class_id ?? null
    default:
      // Check extraColumns
      return dict.extraColumns?.[columnId] ?? null
  }
}

// ---------------------------------------------------------------------------
// Counts subquery (aggregated record + patient counts from event tables)
// ---------------------------------------------------------------------------

/**
 * Build a counts subquery for a dictionary, aggregating record_count and patient_count
 * across all event tables linked to that dictionary.
 * Returns null if no event tables exist for the dictionary.
 */
function buildCountsSubquery(
  mapping: SchemaMapping,
  dictKey: string,
): string | null {
  const eventEntries = getEventTablesForDictionary(mapping, dictKey)
  if (eventEntries.length === 0) return null

  const parts: string[] = []
  for (const { eventTable: et } of eventEntries) {
    const patientCol = et.patientIdColumn ?? mapping.patientTable?.idColumn
    const patientSelect = patientCol ? `"${patientCol}"` : 'NULL'

    parts.push(
      `SELECT "${et.conceptIdColumn}" AS cid, ${patientSelect} AS pid FROM "${et.table}"`,
    )
    if (et.sourceConceptIdColumn) {
      parts.push(
        `SELECT "${et.sourceConceptIdColumn}" AS cid, ${patientSelect} AS pid FROM "${et.table}"`,
      )
    }
  }

  if (parts.length === 0) return null

  return `(SELECT cid AS concept_id, COUNT(*)::INTEGER AS record_count, COUNT(DISTINCT pid)::INTEGER AS patient_count
  FROM (
    ${parts.join('\n    UNION ALL\n    ')}
  ) _evts
  GROUP BY cid)`
}

// ---------------------------------------------------------------------------
// Main queries: concepts list (supports multi-dict UNION ALL)
// ---------------------------------------------------------------------------

function buildSelectForDict(
  dict: ConceptDictionary,
  allColumns: ColumnDescriptor[],
  filters: ConceptFilters,
  _multiDict: boolean,
  mapping: SchemaMapping,
  withCounts: boolean,
): string | null {
  // When counts are streamed/cached separately, skip the expensive GROUP-BY join
  // so the list renders immediately; record/patient counts fall back to 0 and are
  // filled in client-side from the count cache.
  const countsSubquery = withCounts ? buildCountsSubquery(mapping, dict.key) : null
  const hasCounts = countsSubquery !== null
  const where = buildWhereClause(dict, filters, allColumns, 'c')

  const cols: string[] = [
    `c."${dict.idColumn}" AS concept_id`,
    `c."${dict.nameColumn}" AS concept_name`,
  ]

  for (const col of allColumns) {
    if (col.id === 'concept_id' || col.id === 'concept_name') continue
    if (col.source === 'dict') {
      cols.push(`'${esc(dict.key)}' AS _dict_key`)
      continue
    }
    if (col.id === 'record_count') {
      cols.push(hasCounts ? 'COALESCE(_counts.record_count, 0) AS record_count' : '0 AS record_count')
      continue
    }
    if (col.id === 'patient_count') {
      cols.push(hasCounts ? 'COALESCE(_counts.patient_count, 0) AS patient_count' : '0 AS patient_count')
      continue
    }

    const actual = resolveActualColumn(dict, col.id)
    if (actual) {
      cols.push(`c."${actual}" AS "${col.id}"`)
    } else {
      cols.push(`NULL AS "${col.id}"`)
    }
  }

  const joinClause = hasCounts
    ? `LEFT JOIN ${countsSubquery} _counts ON c."${dict.idColumn}" = _counts.concept_id`
    : ''

  return `SELECT ${cols.join(', ')} FROM "${dict.table}" c ${joinClause} ${where}`
}

export function buildConceptsQuery(
  mapping: SchemaMapping,
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
  page: number,
  pageSize: number,
  sorting?: ConceptSorting | null,
  withCounts = true,
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  const multiDict = dicts.length > 1
  const offset = page * pageSize

  // Filter by _dict_key: if set, only query that one dict
  const dictKeys = filterValues(filters._dict_key)
  const activeDicts = dictKeys.length
    ? dicts.filter((d) => dictKeys.includes(d.key))
    : dicts

  if (activeDicts.length === 0) return null

  const subQueries = activeDicts
    .map((d) => buildSelectForDict(d, allColumns, filters, multiDict, mapping, withCounts))
    .filter(Boolean)

  if (subQueries.length === 0) return null

  // ORDER BY — all columns including record_count and patient_count. An explicit
  // sort wins; otherwise a fuzzy search orders by relevance (best tier first).
  let orderBy = 'concept_id'
  if (sorting) {
    orderBy = `"${sorting.columnId}" ${sorting.desc ? 'DESC' : 'ASC'}`
  } else if (aliasedFuzzyRank(filters)) {
    orderBy = `${aliasedFuzzyRank(filters)}, concept_name`
  }

  if (subQueries.length === 1) {
    return `SELECT * FROM (${subQueries[0]}) _q ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
  }

  // Multi-dict: wrap in subquery for ORDER BY + LIMIT
  return `SELECT * FROM (
  ${subQueries.join('\n  UNION ALL\n  ')}
) _union ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
}

/** The full (unpaginated, unfiltered) enriched list with counts — the SELECT
 * materialized to the server-side Parquet cache. Its output columns are the
 * stable aliases the cache page queries then read. */
export function buildConceptsMaterializeQuery(
  mapping: SchemaMapping,
  allColumns: ColumnDescriptor[],
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null
  const multiDict = dicts.length > 1
  const subQueries = dicts
    .map((d) => buildSelectForDict(d, allColumns, EMPTY_FILTERS, multiDict, mapping, true))
    .filter(Boolean)
  if (subQueries.length === 0) return null
  if (subQueries.length === 1) return subQueries[0] as string
  return subQueries.join('\n  UNION ALL\n  ')
}

export function buildConceptsCountQuery(
  mapping: SchemaMapping,
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  const dictKeys = filterValues(filters._dict_key)
  const activeDicts = dictKeys.length
    ? dicts.filter((d) => dictKeys.includes(d.key))
    : dicts

  if (activeDicts.length === 0) return null

  if (activeDicts.length === 1) {
    const dict = activeDicts[0]
    const where = buildWhereClause(dict, filters, allColumns)
    return `SELECT COUNT(*)::INTEGER AS cnt FROM "${dict.table}" ${where}`
  }

  // Multi-dict: sum counts
  const parts = activeDicts.map((dict) => {
    const where = buildWhereClause(dict, filters, allColumns)
    return `SELECT COUNT(*)::INTEGER AS cnt FROM "${dict.table}" ${where}`
  })

  return `SELECT SUM(cnt)::INTEGER AS cnt FROM (${parts.join(' UNION ALL ')}) _counts`
}

// ---------------------------------------------------------------------------
// Filter options (distinct values for dropdown columns)
// ---------------------------------------------------------------------------

export function buildFilterOptionsQuery(
  mapping: SchemaMapping,
  columnId: string,
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  // Collect distinct values across all dicts that have this column
  const parts: string[] = []
  for (const dict of dicts) {
    const actual = resolveActualColumn(dict, columnId)
    if (actual) {
      parts.push(`SELECT DISTINCT "${actual}" AS val FROM "${dict.table}" WHERE "${actual}" IS NOT NULL`)
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
// those aliases — much simpler than the source multi-table SQL. `withCounts` is
// irrelevant here (counts are already materialized as columns).
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
      codeColumn: 'concept_code',
      idColumn: 'concept_id',
    })
    if (fz) conditions.push(fz.where)
  }

  const dictKeyCond = filterCondition('"_dict_key"', filterValues(filters._dict_key))
  if (dictKeyCond) conditions.push(dictKeyCond)

  for (const col of allColumns) {
    if (!col.filterable) continue
    if (col.id === '_dict_key') continue
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
  const rank = aliasedFuzzyRank(filters)
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
// Concept detail (SELECT * for a specific concept)
// ---------------------------------------------------------------------------

export function buildConceptFullQuery(
  mapping: SchemaMapping,
  conceptId: number,
  dictKey?: string,
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  // Alias the id/name columns to concept_id/concept_name (like the list query)
  // so the detail sidebar reads the same fields. EXCLUDE drops the raw source
  // columns first, so when idColumn is literally "concept_id" (OMOP) we don't
  // emit a duplicate column (which DuckDB rejects). SELECT * keeps the rest.
  const selectExpr = (d: ConceptDictionary): string => {
    const excluded = [d.idColumn, d.nameColumn].filter(Boolean).map((c) => `"${c}"`)
    const star = excluded.length ? `c.* EXCLUDE (${excluded.join(', ')})` : 'c.*'
    return `${star}, c."${d.idColumn}" AS concept_id, c."${d.nameColumn}" AS concept_name`
  }

  // If dictKey provided, query that specific dict
  if (dictKey) {
    const dict = dicts.find((d) => d.key === dictKey)
    if (!dict) return null
    return `SELECT ${selectExpr(dict)} FROM "${dict.table}" c WHERE c."${dict.idColumn}" = ${conceptId}`
  }

  // Otherwise, try each dict (concept_id might not be unique across dicts, but typically is)
  if (dicts.length === 1) {
    const dict = dicts[0]
    return `SELECT ${selectExpr(dict)} FROM "${dict.table}" c WHERE c."${dict.idColumn}" = ${conceptId}`
  }

  // Multi-dict: UNION ALL with _dict_key, take first match
  const parts = dicts.map(
    (d) => `SELECT ${selectExpr(d)}, '${esc(d.key)}' AS _dict_key FROM "${d.table}" c WHERE c."${d.idColumn}" = ${conceptId}`,
  )
  return `${parts.join(' UNION ALL ')} LIMIT 1`
}

// ---------------------------------------------------------------------------
// Single concept count (for detail panel)
// ---------------------------------------------------------------------------

export function buildDomainCountQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
): string | null {
  const eventEntries = getEventTablesForDictionary(mapping, dictKey)
  if (eventEntries.length === 0) return null

  // Sum across all event tables for this dict
  const parts: string[] = []
  for (const { eventTable: et } of eventEntries) {
    const matchCond = buildConceptMatchCondition(`"${et.table}"`, et, String(conceptId))
    parts.push(`SELECT COUNT(*)::INTEGER AS cnt FROM "${et.table}" WHERE ${matchCond}`)
  }

  if (parts.length === 1) return parts[0]
  return `SELECT SUM(cnt)::INTEGER AS cnt FROM (${parts.join(' UNION ALL ')}) _counts`
}

// ---------------------------------------------------------------------------
// Value distribution & histogram (unchanged logic, generic interface)
// ---------------------------------------------------------------------------

export function buildValueDistributionQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
): string | null {
  const eventEntries = getEventTablesForDictionary(mapping, dictKey)
  // Find the first event table with a valueColumn
  const entry = eventEntries.find((e) => e.eventTable.valueColumn)
  if (!entry) return null
  const et = entry.eventTable

  const matchCond = buildConceptMatchCondition(`"${et.table}"`, et, String(conceptId))

  return `SELECT
  COUNT(*)::INTEGER AS total_count,
  COUNT("${et.valueColumn}")::INTEGER AS non_null_count,
  ROUND(MIN("${et.valueColumn}")::NUMERIC, 2)::DOUBLE AS min_val,
  ROUND(MAX("${et.valueColumn}")::NUMERIC, 2)::DOUBLE AS max_val,
  ROUND(AVG("${et.valueColumn}")::NUMERIC, 2)::DOUBLE AS mean_val,
  ROUND(MEDIAN("${et.valueColumn}")::NUMERIC, 2)::DOUBLE AS median_val,
  ROUND(STDDEV("${et.valueColumn}")::NUMERIC, 2)::DOUBLE AS std_val
FROM "${et.table}"
WHERE (${matchCond}) AND "${et.valueColumn}" IS NOT NULL`
}

export function buildValueHistogramQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptId: number,
  binCount = 20,
  excludeOutliers = true,
): string | null {
  const eventEntries = getEventTablesForDictionary(mapping, dictKey)
  const entry = eventEntries.find((e) => e.eventTable.valueColumn)
  if (!entry) return null
  const et = entry.eventTable

  const matchCond = buildConceptMatchCondition(`"${et.table}"`, et, String(conceptId))
  const baseWhere = `(${matchCond}) AND "${et.valueColumn}" IS NOT NULL`

  // Bin edges derive from the min/max of the plotted range, so a single absurd
  // value (a respiratory rate of 100000) would collapse every real value into
  // one bar. Clipping to P1–P99 in SQL — before the edges are computed — keeps
  // the bins over the real distribution. `excluded` reports what was dropped so
  // the panel can say so rather than silently hiding data.
  const stats = excludeOutliers
    ? `SELECT
    QUANTILE_CONT("${et.valueColumn}", 0.01) AS mn,
    QUANTILE_CONT("${et.valueColumn}", 0.99) AS mx
  FROM "${et.table}"
  WHERE ${baseWhere}`
    : `SELECT MIN("${et.valueColumn}") AS mn, MAX("${et.valueColumn}") AS mx
  FROM "${et.table}"
  WHERE ${baseWhere}`

  const rangeFilter = excludeOutliers
    ? ` AND "${et.valueColumn}" BETWEEN stats.mn AND stats.mx`
    : ''

  return `WITH stats AS (
  ${stats}
), excluded AS (
  SELECT COUNT(*)::INTEGER AS n
  FROM "${et.table}", stats
  WHERE ${baseWhere}${excludeOutliers ? ` AND ("${et.valueColumn}" < stats.mn OR "${et.valueColumn}" > stats.mx)` : ' AND FALSE'}
)
SELECT
  ROUND((FLOOR(("${et.valueColumn}" - stats.mn) / NULLIF((stats.mx - stats.mn) / ${binCount}.0, 0)) * ((stats.mx - stats.mn) / ${binCount}.0) + stats.mn)::NUMERIC, 2)::DOUBLE AS bin_start,
  COUNT(*)::INTEGER AS count,
  ANY_VALUE(excluded.n) AS excluded_count
FROM "${et.table}", stats, excluded
WHERE ${baseWhere}${rangeFilter}
GROUP BY 1
ORDER BY 1`
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Check if any event table for a dictionary has a valueColumn. */
export function hasValueColumnForDict(mapping: SchemaMapping, dictKey: string): boolean {
  return getEventTablesForDictionary(mapping, dictKey).some((e) => !!e.eventTable.valueColumn)
}
