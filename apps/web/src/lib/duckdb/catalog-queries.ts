import type { SchemaMapping, ConceptDictionary } from '@/types/schema-mapping'
import type { DimensionConfig, ServiceMappingRule, PeriodConfig } from '@/types/catalog'
import { escSql as esc } from '@/lib/format-helpers'
import { classRelation, conceptRelation, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'

/**
 * Resolve a catalog column key (e.g. 'domain_id') to the dictionary relation's
 * column: the category or subcategory when the mapping names that very column,
 * else the extra column declared under that key.
 */
function resolveDictColumn(dict: ConceptDictionary, rel: ClassRelation, alias: string): string | undefined {
  if (dict.categoryColumn === alias) return 'category'
  if (dict.subcategoryColumn === alias) return 'subcategory'
  return rel.extras?.[alias]
}

/** Age in whole years at `refDate`, from the patient relation aliased `p`: the
 *  exact birth date when present, else the birth year (MIMIC-IV leaves every
 *  OMOP birth_datetime empty). */
function ageAt(mapping: SchemaMapping, refDate: string): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!has(patient, 'birth_year')) return null
  const byYear = `EXTRACT(YEAR FROM ${refDate}::TIMESTAMP) - p.birth_year`
  return has(patient, 'birth_date')
    ? `COALESCE(EXTRACT(YEAR FROM AGE(${refDate}::TIMESTAMP, p.birth_date::TIMESTAMP)), ${byYear})`
    : byYear
}

/** The event relations whose concepts a dictionary names. */
function eventsOf(mapping: SchemaMapping, dict: ClassRelation): ClassRelation[] {
  return eventRelations(mapping).filter((e) => e.dictionary === dict.name)
}

// ---------------------------------------------------------------------------
// Dimension SQL expression builders
// ---------------------------------------------------------------------------

function buildAgeGroupExpr(
  brackets: number[],
  mapping: SchemaMapping,
): string | null {
  if (!classRelation(mapping, 'visit')) return null
  const birthExpr = ageAt(mapping, 'v.start_datetime')
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
  if (!has(classRelation(mapping, 'patient'), 'gender')) return null
  return `CASE p.gender WHEN 'male' THEN 'Male' WHEN 'female' THEN 'Female' ELSE 'Other' END`
}

function buildAdmissionDateExpr(
  step: 'day' | 'month' | 'year',
  mapping: SchemaMapping,
): string | null {
  if (!classRelation(mapping, 'visit')) return null
  const fmt = step === 'day' ? '%Y-%m-%d' : step === 'month' ? '%Y-%m' : '%Y'
  return `STRFTIME(v.start_datetime::TIMESTAMP, '${fmt}')`
}

function buildCareSiteExpr(
  mapping: SchemaMapping,
  level: 'visit' | 'visit_detail',
  rules?: ServiceMappingRule[],
): { expr: string; joins: string[] } | null {
  // The catalog's service at stay level is the visit type (admission type), not
  // the care site; at unit level, the looked-up unit name else its raw code.
  if (level === 'visit_detail') {
    if (!has(classRelation(mapping, 'visit_detail'), 'unit_category')) return null
    return { expr: applyServiceMappingRules('vd.unit_category', rules), joins: [] }
  }
  if (!has(classRelation(mapping, 'visit'), 'visit_type')) return null
  return { expr: applyServiceMappingRules('v.visit_type', rules), joins: [] }
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
  const vd = classRelation(mapping, 'visit_detail')
  const vdJoin = dimParts.needsVisitDetail && vd
    ? `LEFT JOIN ${vd.name} vd ON v.visit_id = vd.visit_id AND e.pid = vd.patient_id`
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

  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')
  if (!patient || !visit) return null

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
    if (!dict.idColumn) continue // can't build concept queries without an id column
    const rel = conceptRelation(mapping, dict.key)
    if (!rel) continue
    const eventParts = buildEventPartsForDict(mapping, rel)
    if (eventParts.length === 0) continue

    // 1. Concept list query
    conceptListQueries.push({
      dictKey: dict.key,
      sql: `SELECT DISTINCT concept_id AS cid FROM ${rel.name}`,
      table: rel.name,
      idColumn: 'concept_id',
    })

    // 2. Batch template — concept-level only (simple GROUP BY)
    const cnBaseSql = buildConceptNameSql(dict, rel, hasCategory, hasSubcategory, categoryColumn, subcategoryColumn)

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
    COUNT(DISTINCT v.visit_id)::INTEGER AS visit_count
FROM events e
JOIN ${patient.name} p ON e.pid = p.patient_id
JOIN ${visit.name} v ON e.pid = v.patient_id
JOIN concept_names cn ON e.cid = cn.cid
GROUP BY ${conceptColsStr}`
      },
    })
  }

  if (batchTemplates.length === 0) return null

  // Global query: dim-only margins + grand total (GROUPING SETS)
  const allEventParts: string[] = []
  for (const dict of dicts) {
    const rel = conceptRelation(mapping, dict.key)
    if (rel) allEventParts.push(...buildEventPartsForDict(mapping, rel))
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
    COUNT(DISTINCT v.visit_id)::INTEGER AS visit_count${dimSelectStr}
FROM events e
JOIN ${patient.name} p ON e.pid = p.patient_id
JOIN ${visit.name} v ON e.pid = v.patient_id
${vdJoin}${extraJoinStr}
${globalGroupByClause}`

  return { conceptListQueries, batchTemplates, globalQuery }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEventPartsForDict(mapping: SchemaMapping, dict: ClassRelation): string[] {
  const parts: string[] = []
  for (const event of eventsOf(mapping, dict)) {
    parts.push(`SELECT concept_id AS cid, patient_id AS pid FROM ${event.name}`)
    if (has(event, 'source_concept_id')) {
      parts.push(`SELECT source_concept_id AS cid, patient_id AS pid FROM ${event.name}`)
    }
  }
  return parts
}

function buildConceptNameSql(
  dict: ConceptDictionary,
  rel: ClassRelation,
  hasCategory: boolean,
  hasSubcategory: boolean,
  categoryColumn?: string,
  subcategoryColumn?: string,
): string {
  const catCol = categoryColumn ? resolveDictColumn(dict, rel, categoryColumn) : undefined
  const subcatCol = subcategoryColumn ? resolveDictColumn(dict, rel, subcategoryColumn) : undefined
  const catExpr = catCol ? `"${catCol}"` : 'NULL'
  const subcatExpr = subcatCol ? `"${subcatCol}"` : 'NULL'
  return `SELECT concept_id AS cid, concept_name AS cname${hasCategory ? `, ${catExpr} AS ccat` : ''}${hasSubcategory ? `, ${subcatExpr} AS csubcat` : ''} FROM ${rel.name}`
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
  const visit = classRelation(mapping, 'visit')
  if (!visit) return null
  return `SELECT MIN(start_datetime::TIMESTAMP)::VARCHAR AS min_date, MAX(start_datetime::TIMESTAMP)::VARCHAR AS max_date FROM ${visit.name} WHERE start_datetime IS NOT NULL`
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
  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')
  if (!patient || !visit) return null

  // WHERE clause for the period
  const whereClause = interval.granularity === 'all'
    ? '1=1'
    : `v.start_datetime::TIMESTAMP BETWEEN '${interval.start}'::TIMESTAMP AND '${interval.end} 23:59:59'::TIMESTAMP`

  // Age expression (at visit time)
  const birthExpr = ageAt(mapping, 'v.start_datetime')

  // Service column expression
  let serviceExpr: string | null = null
  let vdJoin = ''
  const vd = classRelation(mapping, 'visit_detail')
  if (periodConfig.serviceLevel === 'visit_detail' && vd) {
    vdJoin = `LEFT JOIN ${vd.name} vd ON v.visit_id = vd.visit_id`
    if (has(vd, 'unit_category')) serviceExpr = applyPeriodServiceMapping('vd.unit_category', smRules)
  } else if (periodConfig.serviceLevel === 'visit' && has(visit, 'visit_type')) {
    serviceExpr = applyPeriodServiceMapping('v.visit_type', smRules)
  }

  // Event tables union for concept categories
  const allEventParts: string[] = []
  if (conceptCategories.length > 0 && categoryColumn && mapping.conceptTables) {
    for (const dict of mapping.conceptTables) {
      const rel = conceptRelation(mapping, dict.key)
      const catCol = rel ? resolveDictColumn(dict, rel, categoryColumn) : undefined
      if (!rel || !catCol) continue
      for (const event of eventsOf(mapping, rel)) {
        const byColumn = (column: string) =>
          `SELECT e.patient_id AS pid, d."${catCol}" AS cat FROM ${event.name} e JOIN ${rel.name} d ON e.${column} = d.concept_id WHERE d."${catCol}" IS NOT NULL`
        allEventParts.push(byColumn('concept_id'))
        if (has(event, 'source_concept_id')) allEventParts.push(byColumn('source_concept_id'))
      }
    }
  }

  // Build SELECT columns
  const selects: string[] = [
    'COUNT(DISTINCT v.visit_id)::INTEGER AS n_sejours',
    'COUNT(DISTINCT v.patient_id)::INTEGER AS n_patients',
  ]

  // Sex columns
  if (has(patient, 'gender')) {
    selects.push(`COUNT(DISTINCT CASE WHEN p.gender = 'male' THEN v.patient_id END)::INTEGER AS sex_m`)
    selects.push(`COUNT(DISTINCT CASE WHEN p.gender = 'female' THEN v.patient_id END)::INTEGER AS sex_f`)
    selects.push(`COUNT(DISTINCT CASE WHEN p.gender = 'unknown' THEN v.patient_id END)::INTEGER AS sex_other`)
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
      selects.push(`COUNT(DISTINCT CASE WHEN ${cond} THEN v.patient_id END)::INTEGER AS "${alias}"`)
    }
  }

  // Service columns
  if (serviceExpr && serviceLabels.length > 0) {
    for (const svcLabel of serviceLabels) {
      const escapedLabel = esc(svcLabel)
      const aliasBase = svcLabel.replace(/[^a-zA-Z0-9]/g, '_')
      selects.push(`COUNT(DISTINCT CASE WHEN ${serviceExpr} = '${escapedLabel}' THEN v.patient_id END)::INTEGER AS "svc_${aliasBase}_pat"`)
      selects.push(`COUNT(DISTINCT CASE WHEN ${serviceExpr} = '${escapedLabel}' THEN v.visit_id END)::INTEGER AS "svc_${aliasBase}_sej"`)
    }
  }

  // Concept category columns (via subquery join)
  if (allEventParts.length > 0 && conceptCategories.length > 0) {
    for (const cat of conceptCategories) {
      const escapedCat = esc(cat)
      const aliasBase = cat.replace(/[^a-zA-Z0-9]/g, '_')
      selects.push(`COUNT(DISTINCT CASE WHEN ev.cat = '${escapedCat}' THEN v.patient_id END)::INTEGER AS "cat_${aliasBase}_pat"`)
      selects.push(`SUM(CASE WHEN ev.cat = '${escapedCat}' THEN 1 ELSE 0 END)::INTEGER AS "cat_${aliasBase}_rows"`)
    }
  }

  const eventsCte = allEventParts.length > 0
    ? `WITH events_cat AS (\n  SELECT DISTINCT pid, cat FROM (\n    ${allEventParts.join('\n    UNION ALL\n    ')}\n  ) _ev\n)\n`
    : ''

  const evJoin = allEventParts.length > 0
    ? 'LEFT JOIN events_cat ev ON v.patient_id = ev.pid'
    : ''

  return `${eventsCte}SELECT
  ${selects.join(',\n  ')}
FROM ${visit.name} v
JOIN ${patient.name} p ON v.patient_id = p.patient_id
${vdJoin}
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
  const vd = classRelation(mapping, 'visit_detail')
  if (serviceLevel === 'visit_detail' && vd) {
    if (!has(vd, 'unit_category')) return null
    return `SELECT DISTINCT ${applyPeriodServiceMapping('unit_category', smRules)} AS svc_label FROM ${vd.name} WHERE unit_category IS NOT NULL ORDER BY svc_label`
  }
  const visit = classRelation(mapping, 'visit')
  if (!has(visit, 'visit_type')) return null
  return `SELECT DISTINCT ${applyPeriodServiceMapping('visit_type', smRules)} AS svc_label FROM ${visit!.name} WHERE visit_type IS NOT NULL ORDER BY svc_label`
}

/** Query to get all distinct category values for a given category column key. */
export function buildCategoryLabelsQuery(
  mapping: SchemaMapping,
  categoryColumn: string,
): string | null {
  const dict = mapping.conceptTables?.[0]
  const rel = dict ? conceptRelation(mapping, dict.key) : undefined
  const catCol = dict && rel ? resolveDictColumn(dict, rel, categoryColumn) : undefined
  if (!rel || !catCol) return null
  return `SELECT DISTINCT "${catCol}" AS cat_label FROM ${rel.name} WHERE "${catCol}" IS NOT NULL ORDER BY cat_label`
}
