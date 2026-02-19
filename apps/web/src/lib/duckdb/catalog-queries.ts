import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import type { DimensionConfig, ServiceMappingRule } from '@/types/catalog'
import { getEventTablesForDictionary } from '@/lib/schema-helpers'

/** Escape a string value for SQL. */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

// ---------------------------------------------------------------------------
// Dimension SQL expression builders
// ---------------------------------------------------------------------------

/**
 * Build a SQL CASE expression for age groups from custom brackets.
 */
function buildAgeGroupExpr(
  brackets: number[],
  mapping: SchemaMapping,
): string | null {
  const pt = mapping.patientTable
  const vt = mapping.visitTable
  if (!pt || !vt) return null

  const birthExpr = pt.birthDateColumn
    ? `EXTRACT(YEAR FROM AGE(v."${vt.startDateColumn}"::TIMESTAMP, p."${pt.birthDateColumn}"::TIMESTAMP))`
    : pt.birthYearColumn
      ? `EXTRACT(YEAR FROM v."${vt.startDateColumn}"::TIMESTAMP) - p."${pt.birthYearColumn}"`
      : null
  if (!birthExpr) return null

  if (brackets.length === 0) return `CAST(FLOOR(${birthExpr}) AS INTEGER)::VARCHAR`

  const sorted = [...brackets].sort((a, b) => a - b)
  const cases: string[] = []

  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i]
    if (i < sorted.length - 1) {
      const hi = sorted[i + 1]
      cases.push(`WHEN ${birthExpr} >= ${lo} AND ${birthExpr} < ${hi} THEN '[${lo};${hi}['`)
    } else {
      cases.push(`WHEN ${birthExpr} >= ${lo} THEN '[${lo};+∞['`)
    }
  }

  if (sorted[0] > 0) {
    cases.unshift(`WHEN ${birthExpr} < ${sorted[0]} THEN '[0;${sorted[0]}['`)
  }

  return `CASE ${cases.join(' ')} END`
}

function buildSexExpr(mapping: SchemaMapping): string | null {
  const pt = mapping.patientTable
  const gv = mapping.genderValues
  if (!pt?.genderColumn || !gv) return null

  return `CASE WHEN p."${pt.genderColumn}" = '${esc(gv.male)}' THEN 'Male' WHEN p."${pt.genderColumn}" = '${esc(gv.female)}' THEN 'Female' ELSE 'Other' END`
}

function buildAdmissionDateExpr(
  step: 'day' | 'month' | 'year',
  mapping: SchemaMapping,
): string | null {
  const vt = mapping.visitTable
  if (!vt) return null

  const fmt = step === 'day' ? '%Y-%m-%d' : step === 'month' ? '%Y-%m' : '%Y'
  return `STRFTIME(v."${vt.startDateColumn}"::TIMESTAMP, '${fmt}')`
}

function buildCareSiteExpr(
  mapping: SchemaMapping,
  level: 'visit' | 'visit_detail',
  rules?: ServiceMappingRule[],
): { expr: string; joins: string[] } | null {
  if (level === 'visit_detail') {
    const vd = mapping.visitDetailTable
    if (!vd?.unitColumn) return null

    let nameExpr: string
    const joins: string[] = []
    if (vd.unitNameTable && vd.unitNameIdColumn && vd.unitNameColumn) {
      joins.push(
        `LEFT JOIN "${vd.unitNameTable}" csn ON vd."${vd.unitColumn}" = csn."${vd.unitNameIdColumn}"`,
      )
      nameExpr = `csn."${vd.unitNameColumn}"`
    } else {
      nameExpr = `vd."${vd.unitColumn}"`
    }

    return { expr: applyServiceMappingRules(nameExpr, rules), joins }
  }

  const vt = mapping.visitTable
  if (!vt?.typeColumn) return null
  return { expr: applyServiceMappingRules(`v."${vt.typeColumn}"`, rules), joins: [] }
}

function applyServiceMappingRules(
  nameExpr: string,
  rules?: ServiceMappingRule[],
): string {
  if (!rules || rules.length === 0) return nameExpr

  const cases: string[] = []
  for (const rule of rules) {
    if (rule.rawValues.length === 0) continue
    const inList = rule.rawValues.map((v) => `'${esc(v)}'`).join(', ')
    cases.push(`WHEN ${nameExpr} IN (${inList}) THEN '${esc(rule.groupLabel)}'`)
  }

  if (cases.length === 0) return nameExpr
  return `CASE ${cases.join(' ')} ELSE ${nameExpr} END`
}

// ---------------------------------------------------------------------------
// Shared dimension resolution
// ---------------------------------------------------------------------------

interface DimensionParts {
  dimSelectExprs: string[]
  dimGroupByAliases: string[]
  extraJoins: string[]
  needsVisitDetail: boolean
  hasDimensions: boolean
}

function resolveDimensions(
  dimensions: DimensionConfig[],
  mapping: SchemaMapping,
  serviceMappingRules?: ServiceMappingRule[],
): DimensionParts {
  const enabledDims = dimensions.filter((d) => d.enabled)
  const dimSelectExprs: string[] = []
  const dimGroupByAliases: string[] = []
  const extraJoins: string[] = []
  let needsVisitDetail = false

  for (const dim of enabledDims) {
    if (dim.type === 'age_group') {
      const expr = buildAgeGroupExpr(dim.ageGroup?.brackets ?? [10, 20, 30, 40, 50, 60, 70, 80, 90], mapping)
      if (expr) {
        dimSelectExprs.push(`${expr} AS dim_age_group`)
        dimGroupByAliases.push('dim_age_group')
      }
    } else if (dim.type === 'sex') {
      const expr = buildSexExpr(mapping)
      if (expr) {
        dimSelectExprs.push(`${expr} AS dim_sex`)
        dimGroupByAliases.push('dim_sex')
      }
    } else if (dim.type === 'admission_date') {
      const expr = buildAdmissionDateExpr(dim.admissionDate?.step ?? 'month', mapping)
      if (expr) {
        dimSelectExprs.push(`${expr} AS dim_admission_date`)
        dimGroupByAliases.push('dim_admission_date')
      }
    } else if (dim.type === 'care_site') {
      const level = dim.careSite?.level ?? 'visit_detail'
      const result = buildCareSiteExpr(mapping, level, serviceMappingRules)
      if (result) {
        dimSelectExprs.push(`${result.expr} AS dim_care_site`)
        dimGroupByAliases.push('dim_care_site')
        extraJoins.push(...result.joins)
        if (level === 'visit_detail') needsVisitDetail = true
      }
    }
  }

  return { dimSelectExprs, dimGroupByAliases, extraJoins, needsVisitDetail, hasDimensions: dimSelectExprs.length > 0 }
}

// ---------------------------------------------------------------------------
// Shared SQL helpers
// ---------------------------------------------------------------------------

function buildJoinClauses(
  mapping: SchemaMapping,
  dimParts: DimensionParts,
): { vdJoin: string; extraJoinStr: string } {
  const vt = mapping.visitTable!
  const vdJoin = dimParts.needsVisitDetail && mapping.visitDetailTable
    ? `LEFT JOIN "${mapping.visitDetailTable.table}" vd ON v."${vt.idColumn}" = vd."${mapping.visitDetailTable.visitIdColumn}" AND e.pid = vd."${mapping.visitDetailTable.patientIdColumn}"`
    : ''
  const extraJoinStr = dimParts.extraJoins.length > 0 ? `\n  ${dimParts.extraJoins.join('\n  ')}` : ''
  return { vdJoin, extraJoinStr }
}

function buildGroupingMeta(
  conceptCols: string[],
  dimGroupByAliases: string[],
): { groupingColumns: string[]; dimBitPositions: Record<string, number>; conceptBitMask: number } {
  const groupingColumns = [...conceptCols, ...dimGroupByAliases]
  const N = groupingColumns.length

  let conceptBitMask = 0
  for (let i = 0; i < conceptCols.length; i++) {
    conceptBitMask |= (1 << (N - 1 - i))
  }

  const dimBitPositions: Record<string, number> = {}
  for (let i = 0; i < dimGroupByAliases.length; i++) {
    const colIndex = conceptCols.length + i
    dimBitPositions[dimGroupByAliases[i]] = N - 1 - colIndex
  }

  return { groupingColumns, dimBitPositions, conceptBitMask }
}

// ---------------------------------------------------------------------------
// Per-dictionary query builder (for incremental progress)
// ---------------------------------------------------------------------------

export interface DictionaryQueryParts {
  dictKey: string
  sql: string
  /** Metadata for decoding grp_flags from this query. */
  meta: { groupingColumns: string[]; dimBitPositions: Record<string, number>; conceptBitMask: number }
  hasDimensions: boolean
}

export interface PerDictionaryQueries {
  /** One query per concept dictionary — produces leaf rows + concept totals. */
  dictQueries: DictionaryQueryParts[]
  /** Global query for dim-only margins + grand total. Always present. */
  globalQuery: string
}

/**
 * Build one SQL query per concept dictionary (leaf rows + concept totals)
 * plus one global query for dim-only margins and grand total.
 */
export function buildPerDictionaryQueries(
  mapping: SchemaMapping,
  dimensions: DimensionConfig[],
  serviceMappingRules?: ServiceMappingRule[],
  categoryColumn?: string,
  subcategoryColumn?: string,
): PerDictionaryQueries | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  const pt = mapping.patientTable
  const vt = mapping.visitTable
  if (!pt || !vt) return null

  const dimParts = resolveDimensions(dimensions, mapping, serviceMappingRules)
  const hasCategory = !!categoryColumn
  const hasSubcategory = !!subcategoryColumn

  const { vdJoin, extraJoinStr } = buildJoinClauses(mapping, dimParts)
  const dimSelectStr = dimParts.dimSelectExprs.length > 0
    ? `,\n    ${dimParts.dimSelectExprs.join(',\n    ')}`
    : ''

  // --- Per-dictionary queries ---
  const dictQueries: DictionaryQueryParts[] = []

  for (const dict of dicts) {
    const eventParts = buildEventPartsForDict(mapping, dict, pt.idColumn)
    if (eventParts.length === 0) continue

    const cnSql = buildConceptNameSql(dict, hasCategory, hasSubcategory, categoryColumn, subcategoryColumn)

    // Concept columns for this per-dict query (no dkey — it's constant)
    const conceptCols = ['cn.cid', 'cn.cname']
    if (hasCategory) conceptCols.push('cn.ccat')
    if (hasSubcategory) conceptCols.push('cn.csubcat')
    const conceptColsStr = conceptCols.join(', ')

    const meta = buildGroupingMeta(conceptCols, dimParts.dimGroupByAliases)
    const groupingExpr = `GROUPING(${meta.groupingColumns.join(', ')})::INTEGER AS grp_flags`

    const catSelectStr = hasCategory ? `,\n    cn.ccat AS concept_category` : ''
    const subcatSelectStr = hasSubcategory ? `,\n    cn.csubcat AS concept_subcategory` : ''

    // Per-dict grouping sets: leaf + concept totals only (no dim-only margins, no grand total)
    const gs: string[] = []
    if (dimParts.hasDimensions) {
      gs.push(`(${conceptColsStr}, ${dimParts.dimGroupByAliases.join(', ')})`)
      gs.push(`(${conceptColsStr})`)
    } else {
      gs.push(`(${conceptColsStr})`)
    }
    const groupByClause = `GROUP BY GROUPING SETS (\n    ${gs.join(',\n    ')}\n  )`

    const sql = `WITH events AS (
  SELECT cid, pid FROM (
    ${eventParts.join('\n    UNION ALL\n    ')}
  ) _evts
  WHERE cid IS NOT NULL
),
concept_names AS (
  ${cnSql}
)
SELECT
    cn.cid AS concept_id,
    cn.cname AS concept_name,
    '${esc(dict.key)}' AS dictionary_key${catSelectStr}${subcatSelectStr},
    COUNT(*)::INTEGER AS record_count,
    COUNT(DISTINCT e.pid)::INTEGER AS patient_count,
    COUNT(DISTINCT v."${vt.idColumn}")::INTEGER AS visit_count${dimSelectStr},
    ${groupingExpr}
FROM events e
JOIN "${pt.table}" p ON e.pid = p."${pt.idColumn}"
JOIN "${vt.table}" v ON e.pid = v."${vt.patientIdColumn}"
${vdJoin}${extraJoinStr}
JOIN concept_names cn ON e.cid = cn.cid
${groupByClause}`

    dictQueries.push({ dictKey: dict.key, sql, meta, hasDimensions: dimParts.hasDimensions })
  }

  if (dictQueries.length === 0) return null

  // --- Global query: dim-only margins + grand total (across all dicts) ---
  const allEventParts: string[] = []
  for (const dict of dicts) {
    allEventParts.push(...buildEventPartsForDict(mapping, dict, pt.idColumn))
  }

  const globalGs: string[] = []
  if (dimParts.hasDimensions) {
    for (const dimAlias of dimParts.dimGroupByAliases) {
      globalGs.push(`(${dimAlias})`)
    }
  }
  globalGs.push('()')
  const globalGroupByClause = `GROUP BY GROUPING SETS (\n    ${globalGs.join(',\n    ')}\n  )`

  const globalQuery = `WITH events AS (
  SELECT cid, pid FROM (
    ${allEventParts.join('\n    UNION ALL\n    ')}
  ) _evts
  WHERE cid IS NOT NULL
)
SELECT
    COUNT(*)::INTEGER AS record_count,
    COUNT(DISTINCT e.pid)::INTEGER AS patient_count,
    COUNT(DISTINCT v."${vt.idColumn}")::INTEGER AS visit_count${dimSelectStr}
FROM events e
JOIN "${pt.table}" p ON e.pid = p."${pt.idColumn}"
JOIN "${vt.table}" v ON e.pid = v."${vt.patientIdColumn}"
${vdJoin}${extraJoinStr}
${globalGroupByClause}`

  return { dictQueries, globalQuery }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEventPartsForDict(
  mapping: SchemaMapping,
  dict: ConceptDictionary,
  defaultPatientIdColumn: string,
): string[] {
  const parts: string[] = []
  const eventEntries = getEventTablesForDictionary(mapping, dict.key)
  for (const { eventTable: et } of eventEntries) {
    const patientCol = et.patientIdColumn ?? defaultPatientIdColumn
    parts.push(
      `SELECT "${et.conceptIdColumn}" AS cid, "${patientCol}" AS pid FROM "${et.table}"`,
    )
    if (et.sourceConceptIdColumn) {
      parts.push(
        `SELECT "${et.sourceConceptIdColumn}" AS cid, "${patientCol}" AS pid FROM "${et.table}"`,
      )
    }
  }
  return parts
}

function buildConceptNameSql(
  dict: ConceptDictionary,
  hasCategory: boolean,
  hasSubcategory: boolean,
  categoryColumn?: string,
  subcategoryColumn?: string,
): string {
  const extras = dict.extraColumns ?? {}
  const catCol = categoryColumn ? extras[categoryColumn] : undefined
  const subcatCol = subcategoryColumn ? extras[subcategoryColumn] : undefined
  const catExpr = catCol ? `"${catCol}"` : 'NULL'
  const subcatExpr = subcatCol ? `"${subcatCol}"` : 'NULL'
  return `SELECT "${dict.idColumn}" AS cid, "${dict.nameColumn}" AS cname${hasCategory ? `, ${catExpr} AS ccat` : ''}${hasSubcategory ? `, ${subcatExpr} AS csubcat` : ''} FROM "${dict.table}"`
}
