import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import type { DimensionConfig, ServiceMappingRule, PeriodConfig } from '@/types/catalog'
import { getEventTablesForDictionary } from '@/lib/schema-helpers'

/** Escape a string value for SQL. */
function esc(value: string): string {
  return value.replace(/'/g, "''")
}

// ---------------------------------------------------------------------------
// Dimension SQL expression builders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Batched query builder (two-table architecture)
// ---------------------------------------------------------------------------

/** SQL to list all distinct concept IDs for one dictionary. */
export interface ConceptListQuery {
  dictKey: string
  sql: string
  table: string
  idColumn: string
}

/**
 * Template for executing a batch of concept IDs within one dictionary.
 * Produces concept-level aggregates only (no dimensions).
 */
export interface BatchQueryTemplate {
  dictKey: string
  buildSql: (conceptIds: (string | number)[]) => string
}

export interface BatchedCatalogQueries {
  /** Queries to list concept IDs per dictionary (fast, no joins). */
  conceptListQueries: ConceptListQuery[]
  /** Templates for batched concept-level queries. */
  batchTemplates: BatchQueryTemplate[]
  /** Global query for dim-only margins + grand total (GROUPING SETS). */
  globalQuery: string
}

/**
 * Build batched catalog queries (two-table architecture):
 * 1. One small query per dict to list concept IDs
 * 2. A template per dict for concept-level aggregates (simple GROUP BY, no dims)
 * 3. A global query for dim-only margins + grand total (GROUPING SETS)
 */
export function buildBatchedCatalogQueries(
  mapping: SchemaMapping,
  dimensions: DimensionConfig[],
  serviceMappingRules?: ServiceMappingRule[],
  categoryColumn?: string,
  subcategoryColumn?: string,
): BatchedCatalogQueries | null {
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

  const conceptListQueries: ConceptListQuery[] = []
  const batchTemplates: BatchQueryTemplate[] = []

  for (const dict of dicts) {
    const eventParts = buildEventPartsForDict(mapping, dict, pt.idColumn)
    if (eventParts.length === 0) continue

    // 1. Concept list query
    conceptListQueries.push({
      dictKey: dict.key,
      sql: `SELECT DISTINCT "${dict.idColumn}" AS cid FROM "${dict.table}"`,
      table: dict.table,
      idColumn: dict.idColumn,
    })

    // 2. Batch template — concept-level only (simple GROUP BY)
    const cnBaseSql = buildConceptNameSql(dict, hasCategory, hasSubcategory, categoryColumn, subcategoryColumn)

    const conceptCols = ['cn.cid', 'cn.cname']
    if (hasCategory) conceptCols.push('cn.ccat')
    if (hasSubcategory) conceptCols.push('cn.csubcat')
    const conceptColsStr = conceptCols.join(', ')

    const catSelectStr = hasCategory ? `,\n    cn.ccat AS concept_category` : ''
    const subcatSelectStr = hasSubcategory ? `,\n    cn.csubcat AS concept_subcategory` : ''

    const eventsSql = eventParts.join('\n    UNION ALL\n    ')
    const dictKeyLiteral = `'${esc(dict.key)}'`

    batchTemplates.push({
      dictKey: dict.key,
      buildSql: (conceptIds) => {
        const inList = conceptIds.map((id) =>
          typeof id === 'string' ? `'${esc(id)}'` : String(id),
        ).join(', ')

        return `WITH events AS (
  SELECT cid, pid FROM (
    ${eventsSql}
  ) _evts
  WHERE cid IN (${inList})
),
concept_names AS (
  ${cnBaseSql}
  WHERE cid IN (${inList})
)
SELECT
    cn.cid AS concept_id,
    cn.cname AS concept_name,
    ${dictKeyLiteral} AS dictionary_key${catSelectStr}${subcatSelectStr},
    COUNT(*)::INTEGER AS record_count,
    COUNT(DISTINCT e.pid)::INTEGER AS patient_count,
    COUNT(DISTINCT v."${vt.idColumn}")::INTEGER AS visit_count
FROM events e
JOIN "${pt.table}" p ON e.pid = p."${pt.idColumn}"
JOIN "${vt.table}" v ON e.pid = v."${vt.patientIdColumn}"
JOIN concept_names cn ON e.cid = cn.cid
GROUP BY ${conceptColsStr}`
      },
    })
  }

  if (batchTemplates.length === 0) return null

  // Global query: dim-only margins + grand total (GROUPING SETS)
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

  return { conceptListQueries, batchTemplates, globalQuery }
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

// ---------------------------------------------------------------------------
// Period table queries
// ---------------------------------------------------------------------------

export interface PeriodInterval {
  granularity: 'month' | 'quarter' | 'year' | 'all'
  /** ISO date of the first day of the period, or '' for ALL. */
  start: string
  /** ISO date of the last day of the period (inclusive), or '' for ALL. */
  end: string
  /** Human-readable label. */
  label: string
}

/**
 * Generate the list of period intervals between minDate and maxDate
 * for the given granularity, plus one 'all' interval at the start.
 */
export function generatePeriodIntervals(
  minDate: string,
  maxDate: string,
  granularity: 'month' | 'quarter' | 'year',
): PeriodInterval[] {
  const intervals: PeriodInterval[] = []

  // ALL row first
  intervals.push({ granularity: 'all', start: '', end: '', label: 'ALL' })

  const start = new Date(minDate)
  const end = new Date(maxDate)

  if (granularity === 'month') {
    const cur = new Date(start.getFullYear(), start.getMonth(), 1)
    while (cur <= end) {
      const y = cur.getFullYear()
      const m = cur.getMonth()
      const periodStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
      const lastDay = new Date(y, m + 1, 0).getDate()
      const periodEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      const label = cur.toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
      intervals.push({ granularity: 'month', start: periodStart, end: periodEnd, label })
      cur.setMonth(cur.getMonth() + 1)
    }
  } else if (granularity === 'quarter') {
    const startQ = Math.floor(start.getMonth() / 3)
    const cur = new Date(start.getFullYear(), startQ * 3, 1)
    while (cur <= end) {
      const y = cur.getFullYear()
      const q = Math.floor(cur.getMonth() / 3) + 1
      const qStartMonth = (q - 1) * 3
      const qEndMonth = qStartMonth + 2
      const periodStart = `${y}-${String(qStartMonth + 1).padStart(2, '0')}-01`
      const lastDay = new Date(y, qEndMonth + 1, 0).getDate()
      const periodEnd = `${y}-${String(qEndMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      intervals.push({ granularity: 'quarter', start: periodStart, end: periodEnd, label: `Q${q} ${y}` })
      cur.setMonth(cur.getMonth() + 3)
    }
  } else {
    // year
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
      intervals.push({
        granularity: 'year',
        start: `${y}-01-01`,
        end: `${y}-12-31`,
        label: String(y),
      })
    }
  }

  return intervals
}

/** SQL query to get the min and max visit start date from the visit table. */
export function buildDateRangeQuery(mapping: SchemaMapping): string | null {
  const vt = mapping.visitTable
  if (!vt) return null
  return `SELECT MIN("${vt.startDateColumn}"::TIMESTAMP)::VARCHAR AS min_date, MAX("${vt.startDateColumn}"::TIMESTAMP)::VARCHAR AS max_date FROM "${vt.table}" WHERE "${vt.startDateColumn}" IS NOT NULL`
}

/**
 * Build the SQL query for one period row (or the ALL row).
 * Returns a query that produces exactly one row with columns:
 *   n_patients, n_sejours, sex_m, sex_f, sex_other,
 *   age_<label> for each age bracket,
 *   svc_<label>_pat, svc_<label>_sej for each service,
 *   cat_<label>_pat, cat_<label>_rows for each concept category.
 */
export function buildPeriodRowQuery(
  mapping: SchemaMapping,
  interval: PeriodInterval,
  periodConfig: PeriodConfig,
  ageBrackets: number[],
  serviceLabels: string[],
  smRules: ServiceMappingRule[] | undefined,
  categoryColumn: string | undefined,
  conceptCategories: string[],
): string | null {
  const pt = mapping.patientTable
  const vt = mapping.visitTable
  if (!pt || !vt) return null

  const gv = mapping.genderValues

  // WHERE clause for the period
  const whereClause = interval.granularity === 'all'
    ? '1=1'
    : `"${vt.startDateColumn}"::TIMESTAMP BETWEEN '${interval.start}'::TIMESTAMP AND '${interval.end} 23:59:59'::TIMESTAMP`

  // Age expression (at visit time)
  const birthExpr = pt.birthDateColumn
    ? `EXTRACT(YEAR FROM AGE(v."${vt.startDateColumn}"::TIMESTAMP, p."${pt.birthDateColumn}"::TIMESTAMP))`
    : pt.birthYearColumn
      ? `EXTRACT(YEAR FROM v."${vt.startDateColumn}"::TIMESTAMP) - p."${pt.birthYearColumn}"`
      : null

  // Service column expression
  let serviceExpr: string | null = null
  let serviceJoin = ''
  if (periodConfig.serviceLevel === 'visit_detail' && mapping.visitDetailTable) {
    const vd = mapping.visitDetailTable
    if (vd.unitColumn) {
      if (vd.unitNameTable && vd.unitNameIdColumn && vd.unitNameColumn) {
        serviceJoin = `LEFT JOIN "${vd.unitNameTable}" csn ON vd."${vd.unitColumn}" = csn."${vd.unitNameIdColumn}"`
        serviceExpr = applyPeriodServiceMapping(`csn."${vd.unitNameColumn}"`, smRules)
      } else {
        serviceExpr = applyPeriodServiceMapping(`vd."${vd.unitColumn}"`, smRules)
      }
    }
  } else if (periodConfig.serviceLevel === 'visit' && vt.typeColumn) {
    serviceExpr = applyPeriodServiceMapping(`v."${vt.typeColumn}"`, smRules)
  }

  // visit_detail JOIN (if needed for service)
  const vdJoin = periodConfig.serviceLevel === 'visit_detail' && mapping.visitDetailTable
    ? `LEFT JOIN "${mapping.visitDetailTable.table}" vd ON v."${vt.idColumn}" = vd."${mapping.visitDetailTable.visitIdColumn}"`
    : ''

  // Event tables union for concept categories
  const allEventParts: string[] = []
  if (conceptCategories.length > 0 && categoryColumn && mapping.conceptTables) {
    for (const dict of mapping.conceptTables) {
      const extras = dict.extraColumns ?? {}
      const catCol = extras[categoryColumn]
      if (!catCol) continue
      const eventEntries = getEventTablesForDictionary(mapping, dict.key)
      for (const { eventTable: et } of eventEntries) {
        const patCol = et.patientIdColumn ?? pt.idColumn
        allEventParts.push(
          `SELECT e."${patCol}" AS pid, d."${catCol}" AS cat FROM "${et.table}" e JOIN "${dict.table}" d ON e."${et.conceptIdColumn}" = d."${dict.idColumn}" WHERE d."${catCol}" IS NOT NULL`,
        )
        if (et.sourceConceptIdColumn) {
          allEventParts.push(
            `SELECT e."${patCol}" AS pid, d."${catCol}" AS cat FROM "${et.table}" e JOIN "${dict.table}" d ON e."${et.sourceConceptIdColumn}" = d."${dict.idColumn}" WHERE d."${catCol}" IS NOT NULL`,
          )
        }
      }
    }
  }

  const patIdCol = vt.patientIdColumn

  // Build SELECT columns
  const selects: string[] = [
    `COUNT(DISTINCT v."${vt.idColumn}")::INTEGER AS n_sejours`,
    `COUNT(DISTINCT v."${patIdCol}")::INTEGER AS n_patients`,
  ]

  // Sex columns
  if (gv && pt.genderColumn) {
    selects.push(`COUNT(DISTINCT CASE WHEN p."${pt.genderColumn}" = '${esc(gv.male)}' THEN v."${patIdCol}" END)::INTEGER AS sex_m`)
    selects.push(`COUNT(DISTINCT CASE WHEN p."${pt.genderColumn}" = '${esc(gv.female)}' THEN v."${patIdCol}" END)::INTEGER AS sex_f`)
    selects.push(`COUNT(DISTINCT CASE WHEN p."${pt.genderColumn}" NOT IN ('${esc(gv.male)}', '${esc(gv.female)}') THEN v."${patIdCol}" END)::INTEGER AS sex_other`)
  } else {
    selects.push('NULL::INTEGER AS sex_m', 'NULL::INTEGER AS sex_f', 'NULL::INTEGER AS sex_other')
  }

  // Age bucket columns
  if (birthExpr && ageBrackets.length > 0) {
    const sorted = [...ageBrackets].sort((a, b) => a - b)
    const bucketDefs: Array<{ lo: number; hi: number | null; label: string }> = []
    if (sorted[0] > 0) bucketDefs.push({ lo: 0, hi: sorted[0], label: `[0;${sorted[0]}[` })
    for (let i = 0; i < sorted.length; i++) {
      const lo = sorted[i]
      const hi = i < sorted.length - 1 ? sorted[i + 1] : null
      const label = hi != null ? `[${lo};${hi}[` : `[${lo};+inf[`
      bucketDefs.push({ lo, hi, label })
    }
    for (const b of bucketDefs) {
      const cond = b.hi != null
        ? `${birthExpr} >= ${b.lo} AND ${birthExpr} < ${b.hi}`
        : `${birthExpr} >= ${b.lo}`
      const alias = `age_${b.label.replace(/[^a-zA-Z0-9]/g, '_')}`
      selects.push(`COUNT(DISTINCT CASE WHEN ${cond} THEN v."${patIdCol}" END)::INTEGER AS "${alias}"`)
    }
  }

  // Service columns
  if (serviceExpr && serviceLabels.length > 0) {
    for (const svcLabel of serviceLabels) {
      const escapedLabel = esc(svcLabel)
      const aliasBase = svcLabel.replace(/[^a-zA-Z0-9]/g, '_')
      selects.push(`COUNT(DISTINCT CASE WHEN ${serviceExpr} = '${escapedLabel}' THEN v."${patIdCol}" END)::INTEGER AS "svc_${aliasBase}_pat"`)
      selects.push(`COUNT(DISTINCT CASE WHEN ${serviceExpr} = '${escapedLabel}' THEN v."${vt.idColumn}" END)::INTEGER AS "svc_${aliasBase}_sej"`)
    }
  }

  // Concept category columns (via subquery join)
  if (allEventParts.length > 0 && conceptCategories.length > 0) {
    for (const cat of conceptCategories) {
      const escapedCat = esc(cat)
      const aliasBase = cat.replace(/[^a-zA-Z0-9]/g, '_')
      selects.push(`COUNT(DISTINCT CASE WHEN ev.cat = '${escapedCat}' THEN v."${patIdCol}" END)::INTEGER AS "cat_${aliasBase}_pat"`)
      selects.push(`SUM(CASE WHEN ev.cat = '${escapedCat}' THEN 1 ELSE 0 END)::INTEGER AS "cat_${aliasBase}_rows"`)
    }
  }

  const eventsCte = allEventParts.length > 0
    ? `,\nevents_cat AS (\n  SELECT DISTINCT pid, cat FROM (\n    ${allEventParts.join('\n    UNION ALL\n    ')}\n  ) _ev\n)`
    : ''

  const evJoin = allEventParts.length > 0
    ? `LEFT JOIN events_cat ev ON v."${patIdCol}" = ev.pid`
    : ''

  return `WITH base_visits AS (
  SELECT v."${vt.idColumn}" AS vid, v."${patIdCol}" AS pid
  FROM "${vt.table}" v
  WHERE ${whereClause}
)${eventsCte}
SELECT
  ${selects.join(',\n  ')}
FROM "${vt.table}" v
JOIN "${pt.table}" p ON v."${patIdCol}" = p."${pt.idColumn}"
${vdJoin}
${serviceJoin}
${evJoin}
WHERE ${whereClause}`
}

function applyPeriodServiceMapping(expr: string, rules?: ServiceMappingRule[]): string {
  if (!rules || rules.length === 0) return expr
  const cases = rules
    .filter((r) => r.rawValues.length > 0)
    .map((r) => {
      const inList = r.rawValues.map((v) => `'${esc(v)}'`).join(', ')
      return `WHEN ${expr} IN (${inList}) THEN '${esc(r.groupLabel)}'`
    })
  if (cases.length === 0) return expr
  return `CASE ${cases.join(' ')} ELSE ${expr} END`
}

/** Query to get all distinct service values (for building service columns). */
export function buildServiceLabelsQuery(
  mapping: SchemaMapping,
  serviceLevel: 'visit' | 'visit_detail',
  smRules?: ServiceMappingRule[],
): string | null {
  if (serviceLevel === 'visit_detail' && mapping.visitDetailTable) {
    const vd = mapping.visitDetailTable
    if (!vd.unitColumn) return null
    let expr: string
    if (vd.unitNameTable && vd.unitNameIdColumn && vd.unitNameColumn) {
      return `SELECT DISTINCT ${applyPeriodServiceMapping(`csn."${vd.unitNameColumn}"`, smRules)} AS svc_label FROM "${vd.table}" vd JOIN "${vd.unitNameTable}" csn ON vd."${vd.unitColumn}" = csn."${vd.unitNameIdColumn}" WHERE vd."${vd.unitColumn}" IS NOT NULL ORDER BY svc_label`
    } else {
      expr = applyPeriodServiceMapping(`vd."${vd.unitColumn}"`, smRules)
      return `SELECT DISTINCT ${expr} AS svc_label FROM "${vd.table}" vd WHERE vd."${vd.unitColumn}" IS NOT NULL ORDER BY svc_label`
    }
  }
  const vt = mapping.visitTable
  if (!vt?.typeColumn) return null
  const expr = applyPeriodServiceMapping(`v."${vt.typeColumn}"`, smRules)
  return `SELECT DISTINCT ${expr} AS svc_label FROM "${vt.table}" v WHERE v."${vt.typeColumn}" IS NOT NULL ORDER BY svc_label`
}

/** Query to get all distinct category values for a given category column key. */
export function buildCategoryLabelsQuery(
  mapping: SchemaMapping,
  categoryColumn: string,
): string | null {
  if (!mapping.conceptTables) return null
  const dict = mapping.conceptTables[0]
  if (!dict) return null
  const extras = dict.extraColumns ?? {}
  const catCol = extras[categoryColumn]
  if (!catCol) return null
  return `SELECT DISTINCT "${catCol}" AS cat_label FROM "${dict.table}" WHERE "${catCol}" IS NOT NULL ORDER BY cat_label`
}
