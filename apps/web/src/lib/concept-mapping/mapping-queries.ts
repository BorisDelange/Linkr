import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import {
  getEventTablesForDictionary,
} from '@/lib/schema-helpers'
import { escSql as esc } from '@/lib/format-helpers'
import { buildFuzzySearchSql } from '@/lib/fuzzy-search'

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
  /** Per-status concept-id sets used to apply the inline mapping-status filter
   *  ("unmapped" / "mapped" / "mapped_elsewhere") at the SQL level so it remains
   *  correct across the full paginated dataset, not just the loaded pages. */
  mappingStatus?: 'unmapped' | 'mapped' | 'mapped_elsewhere'
  mappedConceptIds?: number[]
  /** "Mapped elsewhere" can't always be expressed as a concept_id list because
   *  external mappings are keyed by (vocabulary, code) — the local concept_id
   *  may not yet be loaded. Pass a list of `vocab\0code` keys instead. */
  mappedElsewhereKeys?: string[]
  ignoredConceptIds?: number[]
  /** When true, keep only source concepts that have a suggestion in one of the
   *  selected categories. The union of matching (vocabulary, code) keys is passed
   *  as `suggestionCategoryKeys` (`vocab\0code`), computed from the scores index. */
  hasSuggestionCategoryFilter?: boolean
  suggestionCategoryKeys?: string[]
}

/** Local wrapper around the shared `buildFuzzySearchSql` helper for source-
 *  concepts queries. Source tables only have a single human-readable column
 *  (`concept_name`); we ignore code/id tiers. */
function fuzzySearchClauses(term: string, column: string = 'concept_name'): { rankExpr: string; where: string } | null {
  const sql = buildFuzzySearchSql(term, { nameColumn: column })
  if (!sql) return null
  return { rankExpr: sql.rankExpr, where: sql.where }
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
/** Build a `(vocabulary_id, concept_code) IN ((...),(...))` predicate from
 *  `vocab\0code` keys. DuckDB supports tuple IN. Returns null when empty. */
function tupleInClause(keys: string[]): string | null {
  if (keys.length === 0) return null
  const tuples: string[] = []
  for (const k of keys) {
    const sep = k.indexOf('\0')
    if (sep < 0) continue
    const vocab = esc(k.slice(0, sep))
    const code = esc(k.slice(sep + 1))
    tuples.push(`('${vocab}','${code}')`)
  }
  if (tuples.length === 0) return null
  return `(vocabulary_id, concept_code) IN (${tuples.join(',')})`
}

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
  // Mapping-status filter: emit a SQL predicate built from the id/key sets
  // passed by the caller. Only applied when a non-default status is selected.
  if (filters.mappingStatus && filters.mappingStatus !== ('all' as string)) {
    const mapped = filters.mappedConceptIds ?? []
    const elsewhereKeys = filters.mappedElsewhereKeys ?? []
    const ignored = filters.ignoredConceptIds ?? []
    const idList = (ids: number[]) => ids.length > 0 ? ids.map((n) => Number.isFinite(n) ? n : 0).join(',') : 'NULL'
    if (filters.mappingStatus === 'mapped') {
      conditions.push(`concept_id IN (${idList(mapped)})`)
    } else if (filters.mappingStatus === 'mapped_elsewhere') {
      // Mapped-elsewhere: rows whose (vocabulary, code) is in the cross-project
      // key set, AND whose concept_id is not in the local mapped set (so we
      // don't leak rows that have already been imported locally).
      const tupleClause = tupleInClause(elsewhereKeys)
      if (tupleClause) {
        conditions.push(tupleClause)
        if (mapped.length > 0) conditions.push(`concept_id NOT IN (${idList(mapped)})`)
      } else {
        // No external keys at all → no rows match this filter.
        conditions.push('1=0')
      }
    } else if (filters.mappingStatus === 'unmapped') {
      // Unmapped: not in (mapped or ignored) and not in the elsewhere keyset.
      const all = [...mapped, ...ignored]
      if (all.length > 0) conditions.push(`concept_id NOT IN (${idList(all)})`)
      const tupleClause = tupleInClause(elsewhereKeys)
      if (tupleClause) conditions.push(`NOT ${tupleClause}`)
    }
  }
  // Suggestion-category filter: keep only rows whose (vocabulary, code) has a
  // suggestion in one of the selected categories. Empty key set → no match.
  if (filters.hasSuggestionCategoryFilter) {
    const clause = tupleInClause(filters.suggestionCategoryKeys ?? [])
    conditions.push(clause ?? '1=0')
  }
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
  vocabScope?: FilterOptionsVocabScope,
): string {
  const where = [`${columnName} IS NOT NULL`, `${columnName} != ''`]
  if (vocabScope && vocabScope.values.length > 0) {
    where.push(inListClause(vocabScope.column, vocabScope.values))
  }
  return `SELECT DISTINCT ${columnName} AS val FROM source_concepts WHERE ${where.join(' AND ')} ORDER BY val`
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
  const invalidCol = dict.extraColumns?.invalid_reason

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

  const selectCols = `d.${idCol} AS concept_id, d.${nameCol} AS concept_name, d.${codeCol} AS concept_code, d.${vocabCol} AS vocabulary_id${domainCol ? `, d.${domainCol} AS domain_id` : ''}${classCol ? `, d.${classCol} AS concept_class_id` : ''}${stdCol ? `, d.${stdCol} AS standard_concept` : ''}${invalidCol ? `, d.${invalidCol} AS invalid_reason` : ''}`

  const term = searchTerm.trim()

  // Empty search term: return first N rows matching filters only
  if (!term) {
    const wherePart = filterConds.length > 0 ? ` WHERE ${filterConds.join(' AND ')}` : ''
    return `SELECT ${selectCols} FROM ${dict.table} d${wherePart} ORDER BY d.${idCol} LIMIT ${limit}`
  }

  // Delegate to the shared fuzzy-search helper (see CLAUDE.md → Fuzzy Search).
  // The single combined WHERE selects every match, and `rankExpr` slots each
  // row into the right tier so a top-N ORDER BY surfaces the best matches.
  const fuzzy = buildFuzzySearchSql(term, {
    nameColumn: nameCol,
    codeColumn: codeCol,
    idColumn: idCol,
    alias: 'd',
  })
  if (!fuzzy) {
    const wherePart = filterConds.length > 0 ? ` WHERE ${filterConds.join(' AND ')}` : ''
    return `SELECT ${selectCols} FROM ${dict.table} d${wherePart} LIMIT ${limit}`
  }

  const where = `${fuzzy.where}${filterClause}`
  return `SELECT ${selectCols}, ${fuzzy.rankExpr} AS _rank
  FROM ${dict.table} d
  WHERE ${where}
  ORDER BY _rank
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

  // Same matcher as the search query — share the helper so the COUNT and the
  // ORDER BY query never drift apart.
  const fuzzy = buildFuzzySearchSql(term, {
    nameColumn: nameCol,
    codeColumn: codeCol,
    idColumn: idCol,
    alias: 'd',
  })
  const filterClause = filterConds.length > 0 ? ` AND ${filterConds.join(' AND ')}` : ''
  const where = fuzzy
    ? `WHERE ${fuzzy.where}${filterClause}`
    : (filterConds.length > 0 ? `WHERE ${filterConds.join(' AND ')}` : '')

  return `SELECT COUNT(DISTINCT d.${idCol}) AS total FROM ${dict.table} d ${where}`
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

/** Optional scoping of filter options to a selected vocabulary/terminology.
 *  `column` picks which per-dictionary vocabulary column to constrain (matching
 *  the filter the user selected), and `values` are the selected vocabulary ids
 *  or terminology names. Dictionaries with no such column emit no rows when a
 *  scope is active, so only concepts from the selected vocabularies contribute. */
export interface FilterOptionsVocabScope {
  column: 'vocabulary_id' | 'terminology_name'
  values: string[]
}

export function buildFilterOptionsQuery(
  mapping: SchemaMapping,
  columnAlias: string,
  vocabScope?: FilterOptionsVocabScope,
): string {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0) return ''

  const scoped = vocabScope && vocabScope.values.length > 0 ? vocabScope : undefined

  const unionParts = dicts.map((dict) => {
    let col: string | undefined
    if (columnAlias === 'vocabulary_id') col = dict.terminologyIdColumn ?? dict.vocabularyColumn
    else if (columnAlias === 'terminology_name') col = dict.terminologyNameColumn
    else if (columnAlias === 'category') col = dict.categoryColumn
    else if (columnAlias === 'subcategory') col = dict.subcategoryColumn
    else if (dict.extraColumns?.[columnAlias]) col = dict.extraColumns[columnAlias]
    // When no column exists for vocabulary_id, use the table name as a static value
    if (!col) {
      if (columnAlias === 'vocabulary_id') {
        // Static vocabulary_id = table name: honour the scope by dropping tables
        // whose implicit vocabulary isn't in the selected set.
        if (scoped?.column === 'vocabulary_id' && !scoped.values.includes(dict.table)) return null
        return `SELECT '${dict.table}' AS val`
      }
      return null
    }

    const where = [`${col} IS NOT NULL`]
    if (scoped) {
      const scopeCol = scoped.column === 'vocabulary_id'
        ? (dict.terminologyIdColumn ?? dict.vocabularyColumn)
        : dict.terminologyNameColumn
      // No matching vocabulary column on this dictionary → it can't satisfy the
      // scope, so exclude it entirely rather than returning unscoped values.
      if (!scopeCol) return null
      where.push(inListClause(scopeCol, scoped.values))
    }
    return `SELECT DISTINCT ${col} AS val FROM ${dict.table} WHERE ${where.join(' AND ')}`
  }).filter(Boolean)

  if (unionParts.length === 0) return ''
  return `SELECT DISTINCT val FROM (${unionParts.join(' UNION ALL ')}) ORDER BY val`
}
