import type { SchemaMapping } from '@/types/schema-mapping'
import {
  getEventTablesForDictionary,
  buildConceptMatchCondition,
} from '@/lib/schema-helpers'

/** Escape a string value for use in SQL (prevent injection). */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** Sanitize a data source ID for use as a DuckDB schema name. */
function schemaName(dataSourceId: string): string {
  return `"ds_${dataSourceId.replace(/-/g, '')}"`
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
 * Includes record_count and patient_count from event tables.
 */
export function buildSourceConceptsQuery(
  dataSourceId: string,
  mapping: SchemaMapping,
  filters: SourceConceptFilters,
  sorting: SourceConceptSorting | null,
  limit: number,
  offset: number,
): string {
  const schema = schemaName(dataSourceId)
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  // Build UNION ALL across all concept dictionaries
  const unionParts = dicts.map((dict) => {
    const idCol = dict.idColumn ?? 'concept_id'
    const nameCol = dict.nameColumn ?? 'concept_name'
    const codeCol = dict.codeColumn ? `, ${dict.codeColumn} AS concept_code` : ", '' AS concept_code"
    const vocabCol = dict.vocabularyColumn ? `, ${dict.vocabularyColumn} AS vocabulary_id` : ", '' AS vocabulary_id"

    // Extra columns (domain_id, concept_class_id, standard_concept)
    const extraCols: string[] = []
    if (dict.extraColumns) {
      for (const [alias, col] of Object.entries(dict.extraColumns)) {
        extraCols.push(`, ${col} AS ${alias}`)
      }
    }

    // Record count subquery
    const eventTables = getEventTablesForDictionary(mapping, dict.key)
    let countSubquery = '0'
    let patientSubquery = '0'
    if (eventTables.length > 0) {
      const countParts = eventTables.map(({ eventTable: et }) => {
        const condition = buildConceptMatchCondition('evt', et, `d.${idCol}`)
        return `SELECT COUNT(*) FROM ${schema}.${et.table} evt WHERE ${condition}`
      })
      countSubquery = `(${countParts.join(' + ')})`

      const patientCol = eventTables[0].eventTable.patientIdColumn ?? 'person_id'
      const patientParts = eventTables.map(({ eventTable: et }) => {
        const condition = buildConceptMatchCondition('evt', et, `d.${idCol}`)
        return `SELECT DISTINCT evt.${patientCol} FROM ${schema}.${et.table} evt WHERE ${condition}`
      })
      patientSubquery = `(SELECT COUNT(*) FROM (${patientParts.join(' UNION ')}))`
    }

    return `SELECT
      d.${idCol} AS concept_id,
      d.${nameCol} AS concept_name
      ${codeCol}
      ${vocabCol}
      ${extraCols.join('')},
      ${countSubquery} AS record_count,
      ${patientSubquery} AS patient_count
    FROM ${schema}.${dict.table} d`
  })

  let sql = unionParts.length === 1
    ? `SELECT * FROM (${unionParts[0]}) AS src`
    : `SELECT * FROM (${unionParts.join(' UNION ALL ')}) AS src`

  // WHERE clause
  const conditions: string[] = []
  if (filters.searchText) {
    const term = esc(filters.searchText)
    conditions.push(`(
      CAST(concept_id AS VARCHAR) LIKE '${term}%'
      OR LOWER(concept_name) LIKE LOWER('%${term}%')
      OR LOWER(concept_code) LIKE LOWER('%${term}%')
    )`)
  }
  if (filters.vocabularyId) {
    conditions.push(`vocabulary_id = '${esc(filters.vocabularyId)}'`)
  }
  if (filters.domainId) {
    conditions.push(`domain_id = '${esc(filters.domainId)}'`)
  }
  if (filters.conceptClassId) {
    conditions.push(`concept_class_id = '${esc(filters.conceptClassId)}'`)
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`
  }

  // ORDER BY
  if (sorting) {
    sql += ` ORDER BY ${sorting.columnId} ${sorting.desc ? 'DESC' : 'ASC'} NULLS LAST`
  } else {
    sql += ' ORDER BY record_count DESC NULLS LAST'
  }

  sql += ` LIMIT ${limit} OFFSET ${offset}`
  return sql
}

/**
 * Count query for pagination.
 */
export function buildSourceConceptsCountQuery(
  dataSourceId: string,
  mapping: SchemaMapping,
  filters: SourceConceptFilters,
): string {
  const schema = schemaName(dataSourceId)
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = dicts.map((dict) => {
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
    FROM ${schema}.${dict.table} d`
  })

  let sql = unionParts.length === 1
    ? `SELECT COUNT(*) AS total FROM (${unionParts[0]}) AS src`
    : `SELECT COUNT(*) AS total FROM (${unionParts.join(' UNION ALL ')}) AS src`

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
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`
  }

  return sql
}

// ---------------------------------------------------------------------------
// Standard concept search (target selection)
// ---------------------------------------------------------------------------

/**
 * Search standard concepts in a data source for mapping target selection.
 * Uses vocabularyDataSourceId when available (ATHENA import), otherwise the source DB.
 */
export function buildStandardConceptSearchQuery(
  targetDataSourceId: string,
  mapping: SchemaMapping,
  searchTerm: string,
  domainId?: string,
  limit = 50,
): string {
  const schema = schemaName(targetDataSourceId)
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
  FROM ${schema}.${dict.table} d
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
  targetDataSourceId: string,
  conceptIds: number[],
): string {
  const schema = schemaName(targetDataSourceId)
  const idList = conceptIds.join(', ')
  return `SELECT DISTINCT descendant_concept_id AS concept_id
    FROM ${schema}.concept_ancestor
    WHERE ancestor_concept_id IN (${idList})`
}

export function buildResolveMappedQuery(
  targetDataSourceId: string,
  conceptIds: number[],
): string {
  const schema = schemaName(targetDataSourceId)
  const idList = conceptIds.join(', ')
  return `SELECT DISTINCT concept_id_2 AS concept_id
    FROM ${schema}.concept_relationship
    WHERE concept_id_1 IN (${idList})
      AND relationship_id IN ('Maps to', 'Mapped from')`
}

// ---------------------------------------------------------------------------
// Filter options (distinct values for dropdowns)
// ---------------------------------------------------------------------------

export function buildFilterOptionsQuery(
  dataSourceId: string,
  mapping: SchemaMapping,
  columnAlias: string,
): string {
  const schema = schemaName(dataSourceId)
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = dicts.map((dict) => {
    let col: string | undefined
    if (columnAlias === 'vocabulary_id') col = dict.vocabularyColumn
    else if (dict.extraColumns?.[columnAlias]) col = dict.extraColumns[columnAlias]
    if (!col) return null
    return `SELECT DISTINCT ${col} AS val FROM ${schema}.${dict.table} WHERE ${col} IS NOT NULL`
  }).filter(Boolean)

  if (unionParts.length === 0) return ''
  return `SELECT DISTINCT val FROM (${unionParts.join(' UNION ALL ')}) ORDER BY val`
}
