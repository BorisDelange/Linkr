import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import {
  getEventTablesForDictionary,
} from '@/lib/schema-helpers'

/** Escape a string value for use in SQL (prevent injection). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

// ---------------------------------------------------------------------------
// Source concept filters
// ---------------------------------------------------------------------------

export interface SourceConceptFilters {
  searchText?: string
  vocabularyId?: string
  domainId?: string
  conceptClassId?: string
}

export interface SourceConceptSorting {
  columnId: string
  desc: boolean
}

// ---------------------------------------------------------------------------
// Source concepts (from the clinical database being mapped)
// ---------------------------------------------------------------------------

/**
 * Build a SQL query to load source concepts from a data source's concept table(s).
 * Does NOT include record/patient counts (those are computed once via buildAllConceptCountsQuery).
 *
 * Tables are referenced without schema prefix — the caller (queryDataSource)
 * sets the DuckDB search_path before executing.
 */
export function buildSourceConceptsQuery(
  mapping: SchemaMapping,
  filters: SourceConceptFilters,
  sorting: SourceConceptSorting | null,
  limit: number,
  offset: number,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = buildConceptUnionParts(dicts)

  let sql = unionParts.length === 1
    ? `SELECT * FROM (${unionParts[0]}) AS src`
    : `SELECT * FROM (${unionParts.join(' UNION ALL ')}) AS src`

  sql += buildWhereClause(filters)

  // ORDER BY — record_count/patient_count sorting handled client-side via cached counts
  if (sorting && sorting.columnId !== 'record_count' && sorting.columnId !== 'patient_count') {
    sql += ` ORDER BY ${sorting.columnId} ${sorting.desc ? 'DESC' : 'ASC'} NULLS LAST`
  } else {
    sql += ' ORDER BY concept_name ASC'
  }

  sql += ` LIMIT ${limit} OFFSET ${offset}`
  return sql
}

/**
 * Build a single query that computes record_count and patient_count for ALL
 * concepts in the data source in one pass (using GROUP BY). This should be
 * called once and cached — never on every page change.
 *
 * Returns rows: { concept_id, record_count, patient_count }
 */
export function buildAllConceptCountsQuery(
  mapping: SchemaMapping,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  // For each dictionary, build a UNION ALL of event table records grouped by concept_id
  const allParts: string[] = []

  for (const dict of dicts) {
    const idCol = dict.idColumn ?? 'concept_id'
    const eventTables = getEventTablesForDictionary(mapping, dict.key)
    if (eventTables.length === 0) continue

    for (const { eventTable: et } of eventTables) {
      const patientCol = et.patientIdColumn ?? 'person_id'
      // Build conditions: conceptIdColumn = concept_id [OR sourceConceptIdColumn = concept_id]
      const idCols: string[] = [et.conceptIdColumn]
      if (et.sourceConceptIdColumn) idCols.push(et.sourceConceptIdColumn)

      for (const col of idCols) {
        allParts.push(
          `SELECT evt."${col}" AS concept_id, COUNT(*) AS record_count, COUNT(DISTINCT evt."${patientCol}") AS patient_count FROM ${et.table} evt WHERE evt."${col}" IS NOT NULL GROUP BY evt."${col}"`
        )
      }
    }
  }

  if (allParts.length === 0) return ''

  // Aggregate across all event tables
  return `SELECT concept_id, SUM(record_count) AS record_count, SUM(patient_count) AS patient_count FROM (${allParts.join(' UNION ALL ')}) GROUP BY concept_id`
}

/**
 * Count query for pagination.
 */
export function buildSourceConceptsCountQuery(
  mapping: SchemaMapping,
  filters: SourceConceptFilters,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = buildConceptUnionParts(dicts)

  let sql = unionParts.length === 1
    ? `SELECT COUNT(*) AS total FROM (${unionParts[0]}) AS src`
    : `SELECT COUNT(*) AS total FROM (${unionParts.join(' UNION ALL ')}) AS src`

  sql += buildWhereClause(filters)
  return sql
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build SELECT parts for concept dictionaries (no counts). */
function buildConceptUnionParts(dicts: ConceptDictionary[]): string[] {
  return dicts.map((dict) => {
    const idCol = dict.idColumn ?? 'concept_id'
    const nameCol = dict.nameColumn ?? 'concept_name'
    const codeCol = dict.codeColumn ? `, ${dict.codeColumn} AS concept_code` : ", '' AS concept_code"
    const vocabCol = dict.vocabularyColumn ? `, ${dict.vocabularyColumn} AS vocabulary_id` : ", '' AS vocabulary_id"

    const extraCols: string[] = []
    if (dict.extraColumns) {
      for (const [alias, col] of Object.entries(dict.extraColumns)) {
        extraCols.push(`, ${col} AS ${alias}`)
      }
    }

    return `SELECT
      d.${idCol} AS concept_id,
      d.${nameCol} AS concept_name
      ${codeCol}
      ${vocabCol}
      ${extraCols.join('')}
    FROM ${dict.table} d`
  })
}

/** Build WHERE clause from filters. */
function buildWhereClause(filters: SourceConceptFilters): string {
  const conditions: string[] = []
  if (filters.searchText) {
    const term = esc(filters.searchText)
    conditions.push(`(
      CAST(concept_id AS VARCHAR) LIKE '${term}%'
      OR LOWER(concept_name) LIKE LOWER('%${term}%')
      OR LOWER(concept_code) LIKE LOWER('%${term}%')
    )`)
  }
  if (filters.vocabularyId) conditions.push(`vocabulary_id = '${esc(filters.vocabularyId)}'`)
  if (filters.domainId) conditions.push(`domain_id = '${esc(filters.domainId)}'`)
  if (filters.conceptClassId) conditions.push(`concept_class_id = '${esc(filters.conceptClassId)}'`)
  if (conditions.length > 0) return ` WHERE ${conditions.join(' AND ')}`
  return ''
}

// ---------------------------------------------------------------------------
// Standard concept search (target selection)
// ---------------------------------------------------------------------------

/**
 * Search standard concepts in a data source for mapping target selection.
 */
export function buildStandardConceptSearchQuery(
  mapping: SchemaMapping,
  searchTerm: string,
  domainId?: string,
  limit = 50,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  // Use the first concept dictionary that has standard_concept
  const dict = dicts[0]
  const idCol = dict.idColumn ?? 'concept_id'
  const nameCol = dict.nameColumn ?? 'concept_name'
  const codeCol = dict.codeColumn ?? 'concept_code'
  const vocabCol = dict.vocabularyColumn ?? 'vocabulary_id'

  const conditions = [`LOWER(d.${nameCol}) LIKE LOWER('%${esc(searchTerm)}%')`]

  // Filter for standard concepts if the column exists
  if (dict.extraColumns?.standard_concept) {
    conditions.push(`d.${dict.extraColumns.standard_concept} = 'S'`)
  }
  if (domainId && dict.extraColumns?.domain_id) {
    conditions.push(`d.${dict.extraColumns.domain_id} = '${esc(domainId)}'`)
  }

  return `SELECT
    d.${idCol} AS concept_id,
    d.${nameCol} AS concept_name,
    d.${codeCol} AS concept_code,
    d.${vocabCol} AS vocabulary_id
    ${dict.extraColumns?.domain_id ? `, d.${dict.extraColumns.domain_id} AS domain_id` : ''}
    ${dict.extraColumns?.concept_class_id ? `, d.${dict.extraColumns.concept_class_id} AS concept_class_id` : ''}
  FROM ${dict.table} d
  WHERE ${conditions.join(' AND ')}
  ORDER BY d.${nameCol}
  LIMIT ${limit}`
}

// ---------------------------------------------------------------------------
// Concept set resolution (expand descendants + mapped)
// ---------------------------------------------------------------------------

/**
 * Resolve a set of concept IDs by expanding descendants and/or mapped concepts.
 * Requires concept_ancestor and concept_relationship tables in the target database.
 */
export function buildResolveDescendantsQuery(
  conceptIds: number[],
): string {
  const idList = conceptIds.join(', ')
  return `SELECT DISTINCT descendant_concept_id AS concept_id
    FROM concept_ancestor
    WHERE ancestor_concept_id IN (${idList})`
}

export function buildResolveMappedQuery(
  conceptIds: number[],
): string {
  const idList = conceptIds.join(', ')
  return `SELECT DISTINCT concept_id_2 AS concept_id
    FROM concept_relationship
    WHERE concept_id_1 IN (${idList})
      AND relationship_id IN ('Maps to', 'Mapped from')`
}

// ---------------------------------------------------------------------------
// Filter options (distinct values for dropdowns)
// ---------------------------------------------------------------------------

export function buildFilterOptionsQuery(
  mapping: SchemaMapping,
  columnAlias: string,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = dicts.map((dict) => {
    let col: string | undefined
    if (columnAlias === 'vocabulary_id') col = dict.vocabularyColumn
    else if (dict.extraColumns?.[columnAlias]) col = dict.extraColumns[columnAlias]
    if (!col) return null
    return `SELECT DISTINCT ${col} AS val FROM ${dict.table} WHERE ${col} IS NOT NULL`
  }).filter(Boolean)

  if (unionParts.length === 0) return ''
  return `SELECT DISTINCT val FROM (${unionParts.join(' UNION ALL ')}) ORDER BY val`
}
