import type { SchemaMapping } from '@/types/schema-mapping'
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
 * E.g. brackets=[0, 18, 25, 65, 80] → "0–17", "18–24", "25–64", "65–79", "80+"
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
      const label = `'[${lo};${hi}['`
      cases.push(`WHEN ${birthExpr} >= ${lo} AND ${birthExpr} < ${hi} THEN ${label}`)
    } else {
      cases.push(`WHEN ${birthExpr} >= ${lo} THEN '[${lo};+∞['`)
    }
  }

  // Handle ages below the first bracket
  if (sorted[0] > 0) {
    cases.unshift(`WHEN ${birthExpr} < ${sorted[0]} THEN '[0;${sorted[0]}['`)
  }

  return `CASE ${cases.join(' ')} END`
}

/**
 * Build SQL expression for sex dimension.
 */
function buildSexExpr(mapping: SchemaMapping): string | null {
  const pt = mapping.patientTable
  const gv = mapping.genderValues
  if (!pt?.genderColumn || !gv) return null

  return `CASE WHEN p."${pt.genderColumn}" = '${esc(gv.male)}' THEN 'Male' WHEN p."${pt.genderColumn}" = '${esc(gv.female)}' THEN 'Female' ELSE 'Other' END`
}

/**
 * Build SQL expression for admission date dimension.
 */
function buildAdmissionDateExpr(
  step: 'day' | 'month' | 'year',
  mapping: SchemaMapping,
): string | null {
  const vt = mapping.visitTable
  if (!vt) return null

  const fmt = step === 'day' ? '%Y-%m-%d' : step === 'month' ? '%Y-%m' : '%Y'
  return `STRFTIME(v."${vt.startDateColumn}"::TIMESTAMP, '${fmt}')`
}

/**
 * Build SQL expression for care site dimension.
 * Supports service mapping rules for renaming/grouping.
 */
function buildCareSiteExpr(
  mapping: SchemaMapping,
  level: 'visit' | 'visit_detail',
  rules?: ServiceMappingRule[],
): { expr: string; joins: string[] } | null {
  if (level === 'visit_detail') {
    const vd = mapping.visitDetailTable
    if (!vd?.unitColumn) return null

    // If the unit column is a FK to a name table, join to it
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

  // level === 'visit': use visit table
  // Visit table doesn't have care_site columns in current schema — check visitTable for typeColumn
  // For now, fall back to visit type column if available
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
// Main catalog aggregation query builder
// ---------------------------------------------------------------------------

export interface CatalogQueryParts {
  sql: string
  hasDimensions: boolean
}

/**
 * Build the full catalog aggregation SQL query.
 *
 * Strategy:
 * 1. UNION ALL across all event tables to get concept_id → person_id + visit_id
 * 2. JOIN to person table for age + sex
 * 3. JOIN to visit table for admission date
 * 4. Optionally JOIN to visit_detail + care_site for care site dimension
 * 5. JOIN to concept dictionary for concept_name
 * 6. GROUP BY concept_id, concept_name, [enabled dimensions]
 */
export function buildCatalogAggregationQuery(
  mapping: SchemaMapping,
  dimensions: DimensionConfig[],
  serviceMappingRules?: ServiceMappingRule[],
  categoryColumn?: string,
  subcategoryColumn?: string,
): CatalogQueryParts | null {
  const dicts = mapping.conceptTables
  if (!dicts || dicts.length === 0) return null

  const pt = mapping.patientTable
  const vt = mapping.visitTable
  if (!pt || !vt) return null

  // --- 1. Build events CTE: UNION ALL across all event tables ---
  const eventParts: string[] = []
  for (const dict of dicts) {
    const eventEntries = getEventTablesForDictionary(mapping, dict.key)
    for (const { eventTable: et } of eventEntries) {
      const patientCol = et.patientIdColumn ?? pt.idColumn
      eventParts.push(
        `SELECT "${et.conceptIdColumn}" AS cid, "${patientCol}" AS pid, '${esc(dict.key)}' AS dkey FROM "${et.table}"`,
      )
      if (et.sourceConceptIdColumn) {
        eventParts.push(
          `SELECT "${et.sourceConceptIdColumn}" AS cid, "${patientCol}" AS pid, '${esc(dict.key)}' AS dkey FROM "${et.table}"`,
        )
      }
    }
  }

  if (eventParts.length === 0) return null

  // --- 2. Resolve enabled dimensions ---
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

  const hasDimensions = dimSelectExprs.length > 0

  // --- 3. Build the query ---
  // We need to join events → person (for age/sex) → visit (for admission date, visit_id) → optionally visit_detail → concept dict

  // Build concept name lookup CTE (UNION ALL across all dicts)
  // Include category/subcategory columns from each dictionary's extraColumns
  const hasCategory = !!categoryColumn
  const hasSubcategory = !!subcategoryColumn

  const conceptNameParts = dicts.map((d) => {
    const extras = d.extraColumns ?? {}
    const catCol = categoryColumn ? extras[categoryColumn] : undefined
    const subcatCol = subcategoryColumn ? extras[subcategoryColumn] : undefined
    const catExpr = catCol ? `"${catCol}"` : 'NULL'
    const subcatExpr = subcatCol ? `"${subcatCol}"` : 'NULL'
    return `SELECT "${d.idColumn}" AS cid, "${d.nameColumn}" AS cname, '${esc(d.key)}' AS dkey${hasCategory ? `, ${catExpr} AS ccat` : ''}${hasSubcategory ? `, ${subcatExpr} AS csubcat` : ''} FROM "${d.table}"`
  })
  const conceptNameCte = conceptNameParts.length === 1
    ? conceptNameParts[0]
    : conceptNameParts.join('\n    UNION ALL\n    ')

  // Build visit_detail join if needed
  const vdJoin = needsVisitDetail && mapping.visitDetailTable
    ? `LEFT JOIN "${mapping.visitDetailTable.table}" vd ON v."${vt.idColumn}" = vd."${mapping.visitDetailTable.visitIdColumn}" AND e.pid = vd."${mapping.visitDetailTable.patientIdColumn}"`
    : ''

  const dimSelectStr = dimSelectExprs.length > 0
    ? `,\n    ${dimSelectExprs.join(',\n    ')}`
    : ''

  const dimGroupByStr = dimGroupByAliases.length > 0
    ? `, ${dimGroupByAliases.join(', ')}`
    : ''

  const extraJoinStr = extraJoins.length > 0 ? `\n  ${extraJoins.join('\n  ')}` : ''

  const catSelectStr = hasCategory ? `,\n    cn.ccat AS concept_category` : ''
  const subcatSelectStr = hasSubcategory ? `,\n    cn.csubcat AS concept_subcategory` : ''
  const catCteFields = `${hasCategory ? ', ccat' : ''}${hasSubcategory ? ', csubcat' : ''}`
  const catGroupByStr = `${hasCategory ? ', cn.ccat' : ''}${hasSubcategory ? ', cn.csubcat' : ''}`

  const sql = `WITH events AS (
  SELECT cid, pid, dkey FROM (
    ${eventParts.join('\n    UNION ALL\n    ')}
  ) _evts
  WHERE cid IS NOT NULL
),
concept_names AS (
  SELECT cid, cname, dkey${catCteFields} FROM (
    ${conceptNameCte}
  ) _cn
)
SELECT
    cn.cid AS concept_id,
    cn.cname AS concept_name,
    cn.dkey AS dictionary_key${catSelectStr}${subcatSelectStr},
    COUNT(*)::INTEGER AS record_count,
    COUNT(DISTINCT e.pid)::INTEGER AS patient_count${dimSelectStr}
FROM events e
JOIN "${pt.table}" p ON e.pid = p."${pt.idColumn}"
JOIN "${vt.table}" v ON e.pid = v."${vt.patientIdColumn}"
${vdJoin}${extraJoinStr}
JOIN concept_names cn ON e.cid = cn.cid AND e.dkey = cn.dkey
GROUP BY cn.cid, cn.cname, cn.dkey${catGroupByStr}${dimGroupByStr}
ORDER BY patient_count DESC`

  return { sql, hasDimensions }
}
