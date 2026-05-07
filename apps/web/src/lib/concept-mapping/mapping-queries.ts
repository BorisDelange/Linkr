import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import {
  getEventTablesForDictionary,
} from '@/lib/schema-helpers'
import { escSql as esc } from '@/lib/format-helpers'

// ---------------------------------------------------------------------------
// Source concept filters
// ---------------------------------------------------------------------------

export interface SourceConceptFilters {
  /** Inline column filter (concept_name): simple substring match. */
  searchText?: string
  searchId?: string
  searchCode?: string
  /** Search bar above the table: fuzzy ranked match (substring multi-word + jaro_winkler).
   *  When present, results are ordered by relevance and a `_rank` column is added. */
  searchTextFuzzy?: string
  /** Multi-select column filters: empty array (or undefined) = no filter. */
  vocabularyId?: string[]
  terminologyName?: string[]
  category?: string[]
  subcategory?: string[]
  domainId?: string[]
  conceptClassId?: string[]
}

/** Build the relevance ranking expression and predicate for a fuzzy search term.
 *  Returns `{ rankExpr, where }` where:
 *  - `rankExpr` is a SQL expression evaluating to a number (lower = better match).
 *  - `where` is a SQL predicate that excludes rows with no relevance to the query. */
function fuzzySearchClauses(term: string): { rankExpr: string; where: string } | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const escaped = esc(trimmed)
  const words = trimmed.split(/\s+/).filter(Boolean)
  // Per-word substring match (all words must appear)
  const substringConds = words.map((w) => `LOWER(concept_name) LIKE LOWER('%${esc(w)}%')`).join(' AND ')
  // Per-word fuzzy match: any token in concept_name fuzzy-matches each query word
  const fuzzyConds = words.map((w) => {
    const we = esc(w)
    return `EXISTS (SELECT 1 FROM unnest(string_split(LOWER(concept_name), ' ')) AS t(w) WHERE jaro_winkler_similarity(t.w, LOWER('${we}')) > 0.8)`
  }).join(' AND ')
  // Whole-string similarity: used to score ranking
  const similarity = `jaro_winkler_similarity(LOWER(concept_name), LOWER('${escaped}'))`
  // Tier expression: 1.0 if substring match (best), 2.0 if fuzzy-only.
  // Subtract similarity so that, within a tier, more similar matches rank first.
  const tierExpr = `CASE WHEN (${substringConds}) THEN 1.0 ELSE 2.0 END`
  const rankExpr = `(${tierExpr} - ${similarity})`
  const where = `((${substringConds}) OR (${fuzzyConds}))`
  return { rankExpr, where }
}

/** Render a SQL `column IN (...)` predicate for a multi-select filter, or empty string when no filter. */
function inListClause(column: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return ''
  const escaped = values.map((v) => `'${esc(v)}'`).join(',')
  return `${column} IN (${escaped})`
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
  const isSortingByCount = sorting?.columnId === 'record_count' || sorting?.columnId === 'patient_count'
  const fuzzy = filters.searchTextFuzzy ? fuzzySearchClauses(filters.searchTextFuzzy) : null

  const srcSql = unionParts.length === 1
    ? `(${unionParts[0]})`
    : `(${unionParts.join(' UNION ALL ')})`

  // When sorting by counts, JOIN the counts sub-query so ORDER BY works in SQL
  let sql: string
  if (isSortingByCount) {
    const countsSql = buildAllConceptCountsQuery(mapping)
    if (countsSql) {
      sql = `SELECT src.*, COALESCE(cnt.record_count, 0) AS record_count, COALESCE(cnt.patient_count, 0) AS patient_count FROM ${srcSql} AS src LEFT JOIN (${countsSql}) AS cnt ON src.concept_id = cnt.concept_id`
    } else {
      sql = `SELECT src.*, 0 AS record_count, 0 AS patient_count FROM ${srcSql} AS src`
    }
  } else {
    sql = `SELECT * FROM ${srcSql} AS src`
  }

  sql += buildWhereClause(filters)

  // Sorting precedence: explicit user sort > fuzzy relevance > default (concept_name).
  // This lets the user override the fuzzy ranking by clicking a column header.
  if (sorting) {
    sql += ` ORDER BY ${sorting.columnId} ${sorting.desc ? 'DESC' : 'ASC'} NULLS LAST`
  } else if (fuzzy) {
    sql += ` ORDER BY ${fuzzy.rankExpr} ASC, concept_name ASC`
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
 * Build a SQL query to export ALL source concepts (no pagination).
 */
export function buildSourceConceptsAllQuery(
  mapping: SchemaMapping,
  filters: SourceConceptFilters,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = buildConceptUnionParts(dicts)

  let sql = unionParts.length === 1
    ? `SELECT * FROM (${unionParts[0]}) AS src`
    : `SELECT * FROM (${unionParts.join(' UNION ALL ')}) AS src`

  sql += buildWhereClause(filters)
  sql += ' ORDER BY concept_name ASC'
  return sql
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
    // When idColumn is absent (code-only tables like d_icd_diagnoses), generate a
    // deterministic integer hash from the code column so the rest of the pipeline
    // (which expects concept_id as number) keeps working.
    const idExpr = dict.idColumn
      ? `d.${dict.idColumn} AS concept_id`
      : `(hash(d.${dict.codeColumn ?? 'id'}) % 2147483647)::INTEGER AS concept_id`
    const nameCol = dict.nameColumn ?? 'concept_name'
    const codeCol = dict.codeColumn ? `, d.${dict.codeColumn} AS concept_code` : ", '' AS concept_code"

    // Backward compat: support both terminologyIdColumn and deprecated vocabularyColumn.
    // When neither exists, use the table name as a stable vocabulary identifier.
    const termIdCol = dict.terminologyIdColumn ?? dict.vocabularyColumn
    const vocabCol = termIdCol ? `, d.${termIdCol} AS vocabulary_id` : `, '${dict.table}' AS vocabulary_id`

    const termNameCol = dict.terminologyNameColumn ? `, d.${dict.terminologyNameColumn} AS terminology_name` : ''
    const categoryCol = dict.categoryColumn ? `, d.${dict.categoryColumn} AS category` : ''
    const subcategoryCol = dict.subcategoryColumn ? `, d.${dict.subcategoryColumn} AS subcategory` : ''

    const extraCols: string[] = []
    if (dict.extraColumns) {
      for (const [alias, col] of Object.entries(dict.extraColumns)) {
        extraCols.push(`, d.${col} AS ${alias}`)
      }
    }

    return `SELECT
      ${idExpr},
      d.${nameCol} AS concept_name
      ${codeCol}
      ${vocabCol}
      ${termNameCol}
      ${categoryCol}
      ${subcategoryCol}
      ${extraCols.join('')}
    FROM ${dict.table} d`
  })
}

/** Build WHERE clause from filters. */
function buildWhereClause(filters: SourceConceptFilters): string {
  const conditions: string[] = []
  if (filters.searchText) {
    const term = esc(filters.searchText)
    conditions.push(`LOWER(concept_name) LIKE LOWER('%${term}%')`)
  }
  if (filters.searchId) {
    const term = esc(filters.searchId)
    conditions.push(`CAST(concept_id AS VARCHAR) LIKE '${term}%'`)
  }
  if (filters.searchCode) {
    const term = esc(filters.searchCode)
    conditions.push(`LOWER(concept_code) LIKE LOWER('%${term}%')`)
  }
  if (filters.searchTextFuzzy) {
    const fuzzy = fuzzySearchClauses(filters.searchTextFuzzy)
    if (fuzzy) conditions.push(fuzzy.where)
  }
  for (const c of [
    inListClause('vocabulary_id', filters.vocabularyId),
    inListClause('terminology_name', filters.terminologyName),
    inListClause('category', filters.category),
    inListClause('subcategory', filters.subcategory),
    inListClause('domain_id', filters.domainId),
    inListClause('concept_class_id', filters.conceptClassId),
  ]) if (c) conditions.push(c)
  if (conditions.length > 0) return ` WHERE ${conditions.join(' AND ')}`
  return ''
}

// ---------------------------------------------------------------------------
// File source queries (single table: source_concepts)
// ---------------------------------------------------------------------------

/**
 * Build a SQL query to load file source concepts with filters, sorting, and pagination.
 * The table is a flat `source_concepts` table created by mountFileSourceIntoDuckDB().
 */
export function buildFileSourceConceptsQuery(
  filters: SourceConceptFilters,
  sorting: SourceConceptSorting | null,
  limit: number,
  offset: number,
): string {
  const fuzzy = filters.searchTextFuzzy ? fuzzySearchClauses(filters.searchTextFuzzy) : null
  let sql = 'SELECT * FROM source_concepts'
  sql += buildWhereClause(filters)

  // Sorting precedence: explicit user sort > fuzzy relevance > default.
  if (sorting) {
    // fall through to the original branch below
  } else if (fuzzy) {
    sql += ` ORDER BY ${fuzzy.rankExpr} ASC, concept_name ASC LIMIT ${limit} OFFSET ${offset}`
    return sql
  }
  if (sorting) {
    sql += ` ORDER BY ${sorting.columnId} ${sorting.desc ? 'DESC' : 'ASC'} NULLS LAST`
  } else {
    sql += ' ORDER BY concept_name ASC'
  }

  sql += ` LIMIT ${limit} OFFSET ${offset}`
  return sql
}

/** Count query for file source concepts with filters. */
export function buildFileSourceConceptsCountQuery(
  filters: SourceConceptFilters,
): string {
  let sql = 'SELECT COUNT(*) AS total FROM source_concepts'
  sql += buildWhereClause(filters)
  return sql
}

/** Distinct values for a column in the file source table (for filter dropdowns). */
export function buildFileSourceFilterOptionsQuery(
  columnName: string,
): string {
  return `SELECT DISTINCT ${columnName} AS val FROM source_concepts WHERE ${columnName} IS NOT NULL AND ${columnName} != '' ORDER BY val`
}

// ---------------------------------------------------------------------------
// Standard concept search (target selection)
// ---------------------------------------------------------------------------

/** Filters for the standard concept search query. */
export interface StandardConceptSearchFilters {
  domainIds?: string[]
  vocabularyIds?: string[]
  conceptClassIds?: string[]
  standardConcepts?: string[]
  validConcept?: string
}

/**
 * Search OMOP concepts in a data source for mapping target selection.
 *
 * Search strategy (priority order):
 * 1. Exact match on concept_id (if search term is numeric)
 * 2. Exact match on concept_code
 * 3. Fuzzy match on concept_name (each word must appear as substring)
 *
 * Results are ordered: exact ID matches first, then exact code matches, then name matches.
 */
export function buildStandardConceptSearchQuery(
  mapping: SchemaMapping,
  searchTerm: string,
  filters?: StandardConceptSearchFilters,
  limit = 1000,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const dict = dicts[0]
  const idCol = dict.idColumn ?? 'concept_id'
  const nameCol = dict.nameColumn ?? 'concept_name'
  const codeCol = dict.codeColumn ?? 'concept_code'
  const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn ?? 'vocabulary_id'
  const domainCol = dict.extraColumns?.domain_id ?? dict.categoryColumn
  const classCol = dict.extraColumns?.concept_class_id ?? dict.subcategoryColumn
  const stdCol = dict.extraColumns?.standard_concept

  // Build shared filter conditions (vocabulary, domain, class, standard)
  const filterConds: string[] = []
  if (filters?.vocabularyIds?.length) {
    filterConds.push(`d.${vocabCol} IN (${filters.vocabularyIds.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.domainIds?.length && domainCol) {
    filterConds.push(`d.${domainCol} IN (${filters.domainIds.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.conceptClassIds?.length && classCol) {
    filterConds.push(`d.${classCol} IN (${filters.conceptClassIds.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.standardConcepts?.length && stdCol) {
    filterConds.push(`d.${stdCol} IN (${filters.standardConcepts.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.validConcept === 'valid' && dict.extraColumns?.valid_end_date) {
    filterConds.push(`d.${dict.extraColumns.valid_end_date} > CURRENT_DATE`)
  }
  const filterClause = filterConds.length > 0 ? ` AND ${filterConds.join(' AND ')}` : ''

  const selectCols = `d.${idCol} AS concept_id, d.${nameCol} AS concept_name, d.${codeCol} AS concept_code, d.${vocabCol} AS vocabulary_id${domainCol ? `, d.${domainCol} AS domain_id` : ''}${classCol ? `, d.${classCol} AS concept_class_id` : ''}${stdCol ? `, d.${stdCol} AS standard_concept` : ''}`

  const term = searchTerm.trim()

  // Empty search term: return first N rows matching filters only
  if (!term) {
    const wherePart = filterConds.length > 0 ? ` WHERE ${filterConds.join(' AND ')}` : ''
    return `SELECT ${selectCols} FROM ${dict.table} d${wherePart} ORDER BY d.${idCol} LIMIT ${limit}`
  }

  const escaped = esc(term)
  const isNumeric = /^\d+$/.test(term)

  // Build UNION of exact ID match, exact code match, substring name match, and fuzzy name match
  const parts: string[] = []
  const groupCols = `concept_id, concept_name, concept_code, vocabulary_id${domainCol ? ', domain_id' : ''}${classCol ? ', concept_class_id' : ''}${stdCol ? ', standard_concept' : ''}`

  // Similarity expression: used for ranking across all match tiers
  const simExpr = `GREATEST(jaro_winkler_similarity(LOWER(d.${nameCol}), LOWER('${escaped}')), jaro_winkler_similarity(LOWER(d.${codeCol}), LOWER('${escaped}')))`

  // 1. Exact match on concept_id (if numeric) — tier 0
  if (isNumeric) {
    parts.push(`SELECT ${selectCols}, 0.0 AS _rank FROM ${dict.table} d WHERE d.${idCol} = ${escaped}${filterClause}`)
  }

  // 2. Substring match on concept_code or concept_name — tier 1, sorted by similarity
  const words = term.split(/\s+/).filter(Boolean)
  const substringConds = words.map((w) => {
    const we = esc(w)
    return `(LOWER(d.${nameCol}) LIKE LOWER('%${we}%') OR LOWER(d.${codeCol}) LIKE LOWER('%${we}%'))`
  }).join(' AND ')
  if (substringConds) {
    parts.push(`SELECT ${selectCols}, (2.0 - ${simExpr}) AS _rank FROM ${dict.table} d WHERE ${substringConds}${filterClause}`)
  }

  // 3. Fuzzy match via jaro_winkler_similarity on name and code (score > 0.8) — tier 2
  const fuzzyPerWord = words.map((w) => {
    const we = esc(w)
    return `(EXISTS (SELECT 1 FROM unnest(string_split(LOWER(d.${nameCol}), ' ')) AS t(w) WHERE jaro_winkler_similarity(t.w, LOWER('${we}')) > 0.8) OR jaro_winkler_similarity(LOWER(d.${codeCol}), LOWER('${we}')) > 0.8)`
  })
  if (fuzzyPerWord.length > 0) {
    parts.push(`SELECT ${selectCols}, (3.0 - ${simExpr}) AS _rank FROM ${dict.table} d WHERE ${fuzzyPerWord.join(' AND ')}${filterClause}`)
  }

  return `SELECT ${groupCols}
  FROM (${parts.join(' UNION ALL ')}) sub
  GROUP BY ${groupCols}
  ORDER BY MIN(_rank)
  LIMIT ${limit}`
}

/**
 * Cheap count query for the same set of concepts that buildStandardConceptSearchQuery
 * would return. Skips the ranking joins — just counts distinct concept_ids matching the
 * substring or fuzzy criteria. Uses the same SchemaMapping + filters contract.
 */
export function buildStandardConceptSearchCountQuery(
  mapping: SchemaMapping,
  searchTerm: string,
  filters?: StandardConceptSearchFilters,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const dict = dicts[0]
  const idCol = dict.idColumn ?? 'concept_id'
  const nameCol = dict.nameColumn ?? 'concept_name'
  const codeCol = dict.codeColumn ?? 'concept_code'
  const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn ?? 'vocabulary_id'
  const domainCol = dict.extraColumns?.domain_id ?? dict.categoryColumn
  const classCol = dict.extraColumns?.concept_class_id ?? dict.subcategoryColumn
  const stdCol = dict.extraColumns?.standard_concept

  const filterConds: string[] = []
  if (filters?.vocabularyIds?.length) {
    filterConds.push(`d.${vocabCol} IN (${filters.vocabularyIds.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.domainIds?.length && domainCol) {
    filterConds.push(`d.${domainCol} IN (${filters.domainIds.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.conceptClassIds?.length && classCol) {
    filterConds.push(`d.${classCol} IN (${filters.conceptClassIds.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.standardConcepts?.length && stdCol) {
    filterConds.push(`d.${stdCol} IN (${filters.standardConcepts.map((v) => `'${esc(v)}'`).join(',')})`)
  }
  if (filters?.validConcept === 'valid' && dict.extraColumns?.valid_end_date) {
    filterConds.push(`d.${dict.extraColumns.valid_end_date} > CURRENT_DATE`)
  }

  const term = searchTerm.trim()

  // Empty search term: count all rows matching filters
  if (!term) {
    const wherePart = filterConds.length > 0 ? ` WHERE ${filterConds.join(' AND ')}` : ''
    return `SELECT COUNT(*) AS total FROM ${dict.table} d${wherePart}`
  }

  const escaped = esc(term)
  const isNumeric = /^\d+$/.test(term)
  const filterClause = filterConds.length > 0 ? ` AND ${filterConds.join(' AND ')}` : ''

  // Match if: exact id match (numeric) OR all words appear (substring on name OR code) OR
  // each word matches via fuzzy similarity > 0.8 on name or code.
  const words = term.split(/\s+/).filter(Boolean)
  const substringConds = words.map((w) => {
    const we = esc(w)
    return `(LOWER(d.${nameCol}) LIKE LOWER('%${we}%') OR LOWER(d.${codeCol}) LIKE LOWER('%${we}%'))`
  }).join(' AND ')
  const fuzzyConds = words.map((w) => {
    const we = esc(w)
    return `(EXISTS (SELECT 1 FROM unnest(string_split(LOWER(d.${nameCol}), ' ')) AS t(w) WHERE jaro_winkler_similarity(t.w, LOWER('${we}')) > 0.8) OR jaro_winkler_similarity(LOWER(d.${codeCol}), LOWER('${we}')) > 0.8)`
  }).join(' AND ')

  const matchClauses: string[] = []
  if (isNumeric) matchClauses.push(`d.${idCol} = ${escaped}`)
  if (substringConds) matchClauses.push(`(${substringConds})`)
  if (fuzzyConds) matchClauses.push(`(${fuzzyConds})`)

  const whereClause = matchClauses.length > 0
    ? `WHERE (${matchClauses.join(' OR ')})${filterClause}`
    : filterConds.length > 0 ? `WHERE ${filterConds.join(' AND ')}` : ''

  return `SELECT COUNT(DISTINCT d.${idCol}) AS total FROM ${dict.table} d ${whereClause}`
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

/**
 * Build a query to fetch concept_id → category, subcategory for a list of concept IDs.
 * Used to backfill sourceCategoryId on existing mappings that were created before this field existed.
 * Returns rows: { concept_id, category?, subcategory? }
 */
export function buildConceptCategoryQuery(
  mapping: SchemaMapping,
  conceptIds: number[],
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0 || conceptIds.length === 0) return ''

  const idList = conceptIds.join(',')
  const parts = dicts.map((dict) => {
    const catCol = dict.categoryColumn ? `d.${dict.categoryColumn} AS category` : 'NULL AS category'
    const subCol = dict.subcategoryColumn ? `d.${dict.subcategoryColumn} AS subcategory` : 'NULL AS subcategory'
    let idExpr: string
    if (dict.idColumn) {
      idExpr = `d.${dict.idColumn}`
    } else {
      idExpr = `(hash(d.${dict.codeColumn ?? 'id'}) % 2147483647)::INTEGER`
    }
    return `SELECT ${idExpr} AS concept_id, ${catCol}, ${subCol} FROM ${dict.table} d WHERE ${idExpr} IN (${idList})`
  })

  return `SELECT concept_id, category, subcategory FROM (${parts.join(' UNION ALL ')}) GROUP BY concept_id, category, subcategory`
}

export function buildFilterOptionsQuery(
  mapping: SchemaMapping,
  columnAlias: string,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const unionParts = dicts.map((dict) => {
    let col: string | undefined
    if (columnAlias === 'vocabulary_id') col = dict.terminologyIdColumn ?? dict.vocabularyColumn
    else if (columnAlias === 'terminology_name') col = dict.terminologyNameColumn
    else if (columnAlias === 'category') col = dict.categoryColumn
    else if (columnAlias === 'subcategory') col = dict.subcategoryColumn
    else if (dict.extraColumns?.[columnAlias]) col = dict.extraColumns[columnAlias]
    // When no column exists for vocabulary_id, use the table name as a static value
    if (!col) {
      if (columnAlias === 'vocabulary_id') return `SELECT '${dict.table}' AS val`
      return null
    }
    return `SELECT DISTINCT ${col} AS val FROM ${dict.table} WHERE ${col} IS NOT NULL`
  }).filter(Boolean)

  if (unionParts.length === 0) return ''
  return `SELECT DISTINCT val FROM (${unionParts.join(' UNION ALL ')}) ORDER BY val`
}
