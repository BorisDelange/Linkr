import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import {
  getEventTablesForDictionary,
  buildConceptMatchCondition,
} from '@/lib/schema-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string value for use in SQL (prevent injection). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

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

/**
 * Compute the union of all columns across multiple concept dictionaries.
 * Returns stable column descriptors that drive the table, filters, and sort.
 */
export function computeAvailableColumns(dicts: ConceptDictionary[]): ColumnDescriptor[] {
  const cols: ColumnDescriptor[] = [
    { id: 'concept_id', source: 'core', filterable: false },
    { id: 'concept_name', source: 'core', filterable: false },
  ]

  if (dicts.some((d) => d.codeColumn)) {
    cols.push({ id: 'concept_code', source: 'code', filterable: false })
  }
  if (dicts.some((d) => d.vocabularyColumn)) {
    cols.push({ id: 'vocabulary_id', source: 'vocabulary', filterable: true })
  }

  // Union of all extraColumns keys across all dicts
  const extraKeys = new Set<string>()
  for (const d of dicts) {
    if (d.extraColumns) {
      for (const key of Object.keys(d.extraColumns)) extraKeys.add(key)
    }
  }
  for (const key of extraKeys) {
    cols.push({ id: key, source: 'extra', filterable: true })
  }

  // _dict_key column only if multiple dictionaries
  if (dicts.length > 1) {
    cols.push({ id: '_dict_key', source: 'dict', filterable: true })
  }

  // Computed columns (records + patients) — always last
  cols.push({ id: 'record_count', source: 'computed', filterable: false })
  cols.push({ id: 'patient_count', source: 'computed', filterable: false })

  return cols
}

// ---------------------------------------------------------------------------
// Filters (generic)
// ---------------------------------------------------------------------------

/**
 * Generic filters: key = column alias, value = filter value (null = no filter).
 * Special keys: 'searchText' (fuzzy name), 'searchId' (ID prefix), 'searchCode' (code ILIKE).
 */
export type ConceptFilters = Record<string, string | null>

export const EMPTY_FILTERS: ConceptFilters = {}

function buildWhereClause(dict: ConceptDictionary, filters: ConceptFilters, allColumns: ColumnDescriptor[], alias?: string): string {
  const p = alias ? `${alias}.` : ''
  const conditions: string[] = []

  // Search by ID prefix
  const searchId = filters._searchId
  if (searchId?.trim()) {
    conditions.push(`CAST(${p}"${dict.idColumn}" AS TEXT) ILIKE '${esc(searchId.trim())}%'`)
  }

  // Search by name (multi-word fuzzy)
  const searchText = filters._searchText
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
  const searchCode = filters._searchCode
  if (searchCode?.trim() && dict.codeColumn) {
    conditions.push(`${p}"${dict.codeColumn}" ILIKE '%${esc(searchCode.trim())}%'`)
  }

  // Dropdown / exact-match filters on vocabulary, extra columns
  for (const col of allColumns) {
    if (!col.filterable) continue
    const filterVal = filters[col.id]
    if (!filterVal) continue

    const actualCol = resolveActualColumn(dict, col.id)
    if (!actualCol) continue // column doesn't exist in this dict — skip

    conditions.push(`${p}"${actualCol}" = '${esc(filterVal)}'`)
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
    case 'concept_id': return dict.idColumn
    case 'concept_name': return dict.nameColumn
    case 'concept_code': return dict.codeColumn ?? null
    case 'vocabulary_id': return dict.vocabularyColumn ?? null
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
  multiDict: boolean,
  mapping: SchemaMapping,
): string | null {
  const countsSubquery = buildCountsSubquery(mapping, dict.key)
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
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  const multiDict = dicts.length > 1
  const offset = page * pageSize

  // Filter by _dict_key: if set, only query that one dict
  const dictKeyFilter = filters._dict_key
  const activeDicts = dictKeyFilter
    ? dicts.filter((d) => d.key === dictKeyFilter)
    : dicts

  if (activeDicts.length === 0) return null

  const subQueries = activeDicts
    .map((d) => buildSelectForDict(d, allColumns, filters, multiDict, mapping))
    .filter(Boolean)

  if (subQueries.length === 0) return null

  // ORDER BY — all columns including record_count and patient_count
  let orderBy = 'concept_id'
  if (sorting) {
    orderBy = `"${sorting.columnId}" ${sorting.desc ? 'DESC' : 'ASC'}`
  }

  if (subQueries.length === 1) {
    return `${subQueries[0]} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
  }

  // Multi-dict: wrap in subquery for ORDER BY + LIMIT
  return `SELECT * FROM (
  ${subQueries.join('\n  UNION ALL\n  ')}
) _union ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
}

export function buildConceptsCountQuery(
  mapping: SchemaMapping,
  filters: ConceptFilters,
  allColumns: ColumnDescriptor[],
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  const dictKeyFilter = filters._dict_key
  const activeDicts = dictKeyFilter
    ? dicts.filter((d) => d.key === dictKeyFilter)
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
// Concept detail (SELECT * for a specific concept)
// ---------------------------------------------------------------------------

export function buildConceptFullQuery(
  mapping: SchemaMapping,
  conceptId: number,
  dictKey?: string,
): string | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  // If dictKey provided, query that specific dict
  if (dictKey) {
    const dict = dicts.find((d) => d.key === dictKey)
    if (!dict) return null
    return `SELECT * FROM "${dict.table}" WHERE "${dict.idColumn}" = ${conceptId}`
  }

  // Otherwise, try each dict (concept_id might not be unique across dicts, but typically is)
  if (dicts.length === 1) {
    return `SELECT * FROM "${dicts[0].table}" WHERE "${dicts[0].idColumn}" = ${conceptId}`
  }

  // Multi-dict: UNION ALL with _dict_key, take first match
  const parts = dicts.map(
    (d) => `SELECT *, '${esc(d.key)}' AS _dict_key FROM "${d.table}" WHERE "${d.idColumn}" = ${conceptId}`,
  )
  return `${parts.join(' UNION ALL ')} LIMIT 1`
}

// ---------------------------------------------------------------------------
// Batch counts: records + patients per concept
// ---------------------------------------------------------------------------

/**
 * Build a batch count query for multiple concepts, returning record_count and patient_count.
 * Uses the event tables linked to the given dictionary.
 */
export function buildBatchCountQuery(
  mapping: SchemaMapping,
  dictKey: string,
  conceptIds: number[],
): string | null {
  if (conceptIds.length === 0) return null

  const eventEntries = getEventTablesForDictionary(mapping, dictKey)
  if (eventEntries.length === 0) return null

  const idList = conceptIds.join(',')

  // Collect UNION ALL parts across all event tables for this dict
  const parts: string[] = []
  for (const { eventTable: et } of eventEntries) {
    const patientCol = et.patientIdColumn ?? mapping.patientTable?.idColumn
    const patientSelect = patientCol ? `"${patientCol}"` : 'NULL'

    parts.push(
      `SELECT "${et.conceptIdColumn}" AS cid, ${patientSelect} AS pid FROM "${et.table}" WHERE "${et.conceptIdColumn}" IN (${idList})`,
    )
    if (et.sourceConceptIdColumn) {
      parts.push(
        `SELECT "${et.sourceConceptIdColumn}" AS cid, ${patientSelect} AS pid FROM "${et.table}" WHERE "${et.sourceConceptIdColumn}" IN (${idList})`,
      )
    }
  }

  if (parts.length === 0) return null

  return `SELECT cid AS concept_id, COUNT(*)::INTEGER AS record_count, COUNT(DISTINCT pid)::INTEGER AS patient_count
FROM (
  ${parts.join('\n  UNION ALL\n  ')}
) sub
GROUP BY cid`
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
): string | null {
  const eventEntries = getEventTablesForDictionary(mapping, dictKey)
  const entry = eventEntries.find((e) => e.eventTable.valueColumn)
  if (!entry) return null
  const et = entry.eventTable

  const matchCond = buildConceptMatchCondition(`"${et.table}"`, et, String(conceptId))

  return `WITH stats AS (
  SELECT MIN("${et.valueColumn}") AS mn, MAX("${et.valueColumn}") AS mx
  FROM "${et.table}"
  WHERE (${matchCond}) AND "${et.valueColumn}" IS NOT NULL
)
SELECT
  ROUND((FLOOR(("${et.valueColumn}" - stats.mn) / NULLIF((stats.mx - stats.mn) / ${binCount}.0, 0)) * ((stats.mx - stats.mn) / ${binCount}.0) + stats.mn)::NUMERIC, 2)::DOUBLE AS bin_start,
  COUNT(*)::INTEGER AS count
FROM "${et.table}", stats
WHERE (${matchCond}) AND "${et.valueColumn}" IS NOT NULL
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
