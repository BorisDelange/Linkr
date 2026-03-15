import type {
  Cohort,
  CohortLevel,
  CriteriaOperator,
  CriteriaTreeNode,
  CriterionNode,
  CriteriaGroupNode,
  AgeCriteriaConfig,
  SexCriteriaConfig,
  DeathCriteriaConfig,
  PeriodCriteriaConfig,
  DurationCriteriaConfig,
  CareSiteCriteriaConfig,
  ConceptCriteriaConfig,
} from '@/types'
import type { SchemaMapping, EventTable } from '@/types'
import { escSql, validateIntegerIds } from '@/lib/format-helpers'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reusable query parts (FROM + WHERE) from a Cohort criteria tree.
 * Used by buildCohortCountSql, buildCohortResultsSql, and patient-data-queries.
 */
export interface CohortQueryParts {
  baseTable: string
  idColumn: string
  from: string
  whereClause: string
}

/**
 * Build reusable query parts (FROM + WHERE) from a Cohort definition.
 */
export function buildCohortQueryParts(cohort: Cohort, mapping: SchemaMapping): CohortQueryParts | null {
  const baseTable = getBaseTable(cohort.level, mapping)
  const idColumn = getIdColumn(cohort.level, mapping)
  if (!baseTable || !idColumn) return null

  const where = buildTreeWhereClause(cohort.criteriaTree, cohort.level, mapping, baseTable)
  const from = buildFromClause(cohort.level, mapping, cohort.criteriaTree, baseTable)

  return {
    baseTable,
    idColumn,
    from,
    whereClause: where && where !== '1=1' ? where : '',
  }
}

/**
 * Build a COUNT(DISTINCT id) query from a Cohort definition.
 */
export function buildCohortCountSql(cohort: Cohort, mapping: SchemaMapping): string | null {
  const parts = buildCohortQueryParts(cohort, mapping)
  if (!parts) return null

  const lines = [
    `SELECT`,
    `  COUNT(DISTINCT "${parts.baseTable}"."${parts.idColumn}") AS cnt`,
    `FROM`,
    `  ${parts.from}`,
  ]
  if (parts.whereClause) {
    lines.push(`WHERE`, `  ${parts.whereClause}`)
  }
  return lines.join('\n')
}

/**
 * Build a paginated SELECT query returning result rows.
 */
export function buildCohortResultsSql(
  cohort: Cohort,
  mapping: SchemaMapping,
  limit: number = 50,
  offset: number = 0,
): string | null {
  const parts = buildCohortQueryParts(cohort, mapping)
  if (!parts) return null

  const selectCols = buildSelectColumns(cohort.level, mapping, parts.baseTable)
  const lines = [
    `SELECT DISTINCT`,
    `  ${selectCols}`,
    `FROM`,
    `  ${parts.from}`,
  ]
  if (parts.whereClause) {
    lines.push(`WHERE`, `  ${parts.whereClause}`)
  }
  lines.push(
    `ORDER BY`,
    `  "${parts.baseTable}"."${parts.idColumn}"`,
    `LIMIT ${limit}`,
    `OFFSET ${offset}`,
  )
  return lines.join('\n')
}

/**
 * Build attrition queries: one COUNT per top-level child, progressively accumulated.
 */
export function buildAttritionQueries(
  cohort: Cohort,
  mapping: SchemaMapping,
): { nodeId: string; label: string; sql: string }[] {
  const baseTable = getBaseTable(cohort.level, mapping)
  const idColumn = getIdColumn(cohort.level, mapping)
  if (!baseTable || !idColumn) return []

  const queries: { nodeId: string; label: string; sql: string }[] = []

  // Base FROM clause without criteria-dependent joins
  const baseFrom = buildFromClause(cohort.level, mapping, null, baseTable)

  // Total without any criteria
  queries.push({
    nodeId: '__total__',
    label: 'Total',
    sql: [
      `SELECT`,
      `  COUNT(DISTINCT "${baseTable}"."${idColumn}") AS cnt`,
      `FROM`,
      `  ${baseFrom}`,
    ].join('\n'),
  })

  // Progressive accumulation of top-level children
  const enabledChildren = cohort.criteriaTree.children.filter((c) => c.enabled)
  for (let i = 0; i < enabledChildren.length; i++) {
    const progressiveTree: CriteriaGroupNode = {
      ...cohort.criteriaTree,
      children: enabledChildren.slice(0, i + 1),
    }
    const from = buildFromClause(cohort.level, mapping, progressiveTree, baseTable)
    const where = buildTreeWhereClause(progressiveTree, cohort.level, mapping, baseTable)
    const lines = [
      `SELECT`,
      `  COUNT(DISTINCT "${baseTable}"."${idColumn}") AS cnt`,
      `FROM`,
      `  ${from}`,
    ]
    if (where && where !== '1=1') {
      lines.push(`WHERE`, `  ${where}`)
    }
    queries.push({
      nodeId: enabledChildren[i].id,
      label: getNodeLabel(enabledChildren[i]),
      sql: lines.join('\n'),
    })
  }

  return queries
}

// ---------------------------------------------------------------------------
// Tree → WHERE clause (recursive)
// ---------------------------------------------------------------------------

function buildTreeWhereClause(
  node: CriteriaTreeNode,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (!node.enabled) return '1=1'

  if (node.kind === 'criterion') {
    const clause = buildCriterionClause(node, level, mapping, baseTable)
    return node.exclude ? `NOT (${clause})` : clause
  }

  // Group node: each child carries its own operator linking it to the previous sibling
  const enabledChildren = node.children.filter((c) => c.enabled)
  const childResults: { clause: string; operator: CriteriaOperator }[] = []

  for (const child of enabledChildren) {
    const clause = buildTreeWhereClause(child, level, mapping, baseTable)
    if (clause !== '1=1') {
      childResults.push({ clause, operator: child.operator })
    }
  }

  if (childResults.length === 0) return '1=1'

  // Build the combined clause respecting per-node operators and precedence
  // AND has higher precedence than OR, so we group consecutive AND-linked clauses
  const joined = buildPrecedenceClause(childResults)

  return node.exclude ? `NOT (${joined})` : joined
}

/**
 * Build a SQL clause respecting AND > OR precedence.
 * Groups consecutive AND-linked items, then joins those groups with OR.
 */
function buildPrecedenceClause(items: { clause: string; operator: CriteriaOperator }[]): string {
  if (items.length === 1) return items[0].clause

  // Split into OR-separated groups of AND-linked items
  const andGroups: { clause: string; operator: CriteriaOperator }[][] = [[items[0]]]

  for (let i = 1; i < items.length; i++) {
    if (items[i].operator === 'OR') {
      andGroups.push([items[i]])
    } else {
      andGroups[andGroups.length - 1].push(items[i])
    }
  }

  if (andGroups.length === 1) {
    // All AND — join with line breaks
    return andGroups[0]
      .map((item) => `(${item.clause})`)
      .join('\n  AND ')
  }

  // Multiple OR groups
  const orParts = andGroups.map((group) => {
    if (group.length === 1) return group[0].clause
    return group
      .map((item) => `(${item.clause})`)
      .join('\n    AND ')
  })

  return orParts
    .map((p) => `(${p})`)
    .join('\n  OR ')
}

// ---------------------------------------------------------------------------
// Individual criterion → SQL clause
// ---------------------------------------------------------------------------

function buildCriterionClause(
  criterion: CriterionNode,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  switch (criterion.type) {
    case 'age':
      return buildAgeCriteria(criterion.config as AgeCriteriaConfig, level, mapping, baseTable)
    case 'sex':
      return buildSexCriteria(criterion.config as SexCriteriaConfig, level, mapping)
    case 'death':
      return buildDeathCriteria(criterion.config as DeathCriteriaConfig, level, mapping)
    case 'period':
      return buildPeriodCriteria(criterion.config as PeriodCriteriaConfig, level, mapping, baseTable)
    case 'duration':
      return buildDurationCriteria(criterion.config as DurationCriteriaConfig, level, mapping, baseTable)
    case 'care_site':
      return buildCareSiteCriteria(criterion.config as CareSiteCriteriaConfig, level, mapping, baseTable)
    case 'concept':
      return buildConceptCriteria(criterion.config as ConceptCriteriaConfig, level, mapping, baseTable)
    case 'text':
      return '1=1' // Free text is purely descriptive, no SQL filter
    default:
      return '1=1'
  }
}

// --- Age ---

function buildAgeCriteria(
  config: AgeCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  const pt = mapping.patientTable
  if (!pt) return '1=1'

  const personRef = level === 'patient' ? `"${pt.table}"` : 'p'

  let dateRef: string
  if (config.ageReference === 'admission') {
    if (level === 'patient') {
      // Patient level: use earliest visit start date via subquery
      const vt = mapping.visitTable
      if (vt?.startDateColumn) {
        dateRef = `(SELECT MIN("${vt.startDateColumn}") FROM "${vt.table}" WHERE "${vt.table}"."${vt.patientIdColumn}" = "${pt.table}"."${pt.idColumn}")`
      } else {
        dateRef = 'CURRENT_DATE'
      }
    } else {
      const startDateCol = getStartDateColumn(level, mapping)
      dateRef = startDateCol ? `"${baseTable}"."${startDateCol}"` : 'CURRENT_DATE'
    }
  } else {
    dateRef = 'CURRENT_DATE'
  }

  let ageExpr: string
  if (pt.birthDateColumn) {
    ageExpr = `DATE_PART('year', ${dateRef}) - DATE_PART('year', ${personRef}."${pt.birthDateColumn}")`
  } else if (pt.birthYearColumn) {
    ageExpr = `DATE_PART('year', ${dateRef}::TIMESTAMP) - ${personRef}."${pt.birthYearColumn}"`
  } else {
    return '1=1'
  }

  const parts: string[] = []
  if (config.min != null) parts.push(`${ageExpr} >= ${config.min}`)
  if (config.max != null) parts.push(`${ageExpr} <= ${config.max}`)
  return parts.join(' AND\n    ') || '1=1'
}

// --- Sex ---

function buildSexCriteria(
  config: SexCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
): string {
  if (config.values.length === 0) return '1=1'
  const pt = mapping.patientTable
  if (!pt?.genderColumn) return '1=1'
  const personRef = level === 'patient' ? `"${pt.table}"` : 'p'
  const vals = config.values.map((v) => `'${escSql(v)}'`).join(', ')
  return `${personRef}."${pt.genderColumn}" IN (${vals})`
}

// --- Death ---

function buildDeathCriteria(
  config: DeathCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
): string {
  const pt = mapping.patientTable
  const personRef = level === 'patient' ? (pt ? `"${pt.table}"` : null) : 'p'
  if (!personRef) return '1=1'

  // Check patient table death date column first
  if (pt?.deathDateColumn) {
    return config.isDead
      ? `${personRef}."${pt.deathDateColumn}" IS NOT NULL`
      : `${personRef}."${pt.deathDateColumn}" IS NULL`
  }

  // Fall back to separate death table
  const dt = mapping.deathTable
  if (dt) {
    const patientIdCol = pt?.idColumn ?? 'person_id'
    const subquery = `SELECT 1 FROM "${dt.table}" WHERE "${dt.table}"."${dt.patientIdColumn}" = ${personRef}."${patientIdCol}"`
    return config.isDead ? `EXISTS (${subquery})` : `NOT EXISTS (${subquery})`
  }

  return '1=1'
}

// --- Period ---

function buildPeriodCriteria(
  config: PeriodCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (!config.startDate && !config.endDate) return '1=1'

  if (level === 'patient') {
    // Patient level: filter via subquery on visit table
    const vt = mapping.visitTable
    if (!vt?.startDateColumn) return '1=1'
    const pt = mapping.patientTable
    if (!pt) return '1=1'
    const conditions: string[] = []
    if (config.startDate) conditions.push(`"${vt.startDateColumn}" >= '${escSql(config.startDate)}'`)
    if (config.endDate) conditions.push(`"${vt.startDateColumn}" <= '${escSql(config.endDate)}'`)
    return [
      `EXISTS (`,
      `    SELECT 1 FROM "${vt.table}"`,
      `    WHERE "${vt.table}"."${vt.patientIdColumn}" = "${baseTable}"."${pt.idColumn}"`,
      `      AND ${conditions.join(' AND ')}`,
      `)`,
    ].join('\n')
  }

  const startDateCol = getStartDateColumn(level, mapping)
  if (!startDateCol) return '1=1'
  const dateRef = `"${baseTable}"."${startDateCol}"`
  const parts: string[] = []
  if (config.startDate) parts.push(`${dateRef} >= '${escSql(config.startDate)}'`)
  if (config.endDate) parts.push(`${dateRef} <= '${escSql(config.endDate)}'`)
  return parts.join(' AND ') || '1=1'
}

// --- Duration ---

function buildDurationCriteria(
  config: DurationCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (config.minDays == null && config.maxDays == null) return '1=1'

  const targetLevel = config.durationLevel ?? 'visit'
  const datePart = config.durationUnit === 'hours' ? 'hour' : 'day'

  // Build the duration filter conditions for the target level
  const targetStartCol = getStartDateColumn(targetLevel, mapping)
  const targetEndCol = getEndDateColumn(targetLevel, mapping)
  if (!targetStartCol || !targetEndCol) return '1=1'

  const targetTable = getBaseTable(targetLevel, mapping)
  if (!targetTable) return '1=1'

  // If the target level matches the cohort level, filter directly
  if (targetLevel === level) {
    const durExpr = `DATE_DIFF('${datePart}', "${baseTable}"."${targetStartCol}", "${baseTable}"."${targetEndCol}")`
    const parts: string[] = []
    if (config.minDays != null) parts.push(`${durExpr} >= ${config.minDays}`)
    if (config.maxDays != null) parts.push(`${durExpr} <= ${config.maxDays}`)
    return parts.join(' AND ')
  }

  // Otherwise use a subquery (e.g. patient level filtering on visit duration)
  const durExpr = `DATE_DIFF('${datePart}', "${targetTable}"."${targetStartCol}", "${targetTable}"."${targetEndCol}")`
  const durConditions: string[] = []
  if (config.minDays != null) durConditions.push(`${durExpr} >= ${config.minDays}`)
  if (config.maxDays != null) durConditions.push(`${durExpr} <= ${config.maxDays}`)

  // Link target to base table
  const linkCondition = buildSubqueryLink(level, targetLevel, mapping, baseTable, targetTable)
  if (!linkCondition) return '1=1'

  return [
    `EXISTS (`,
    `    SELECT 1 FROM "${targetTable}"`,
    `    WHERE ${linkCondition}`,
    `      AND ${durConditions.join(' AND ')}`,
    `)`,
  ].join('\n')
}

// --- Care Site ---

function buildCareSiteCriteria(
  config: CareSiteCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (config.values.length === 0) return '1=1'

  const targetLevel = config.careSiteLevel ?? 'visit_detail'
  const vals = config.values.map((v) => `'${escSql(v)}'`).join(', ')

  // Get the care site column info for the target level
  let careSiteCol: string | undefined
  let targetTable: string | undefined
  let lookupTable: string | undefined
  let lookupIdCol: string | undefined
  let lookupNameCol: string | undefined

  if (targetLevel === 'visit') {
    const vt = mapping.visitTable
    careSiteCol = vt?.careSiteColumn
    targetTable = vt?.table
    lookupTable = vt?.careSiteNameTable
    lookupIdCol = vt?.careSiteNameIdColumn
    lookupNameCol = vt?.careSiteNameColumn
  } else {
    const vdt = mapping.visitDetailTable
    careSiteCol = vdt?.unitColumn
    targetTable = vdt?.table
    lookupTable = vdt?.unitNameTable
    lookupIdCol = vdt?.unitNameIdColumn
    lookupNameCol = vdt?.unitNameColumn
  }

  if (!careSiteCol || !targetTable) return '1=1'

  // Build the match condition: if there's a lookup table, match by name; otherwise match directly
  let matchCondition: string
  if (lookupTable && lookupIdCol && lookupNameCol) {
    // Match via lookup table (name-based matching)
    matchCondition = `"${targetTable}"."${careSiteCol}" IN (SELECT "${lookupIdCol}" FROM "${lookupTable}" WHERE "${lookupNameCol}" IN (${vals}))`
  } else {
    // Direct match on the column value
    matchCondition = `"${targetTable}"."${careSiteCol}" IN (${vals})`
  }

  // If target level matches cohort level, filter directly
  if (targetLevel === level) {
    return matchCondition
  }

  // Otherwise use a subquery
  const linkCondition = buildSubqueryLink(level, targetLevel, mapping, baseTable, targetTable)
  if (!linkCondition) return '1=1'

  return [
    `EXISTS (`,
    `    SELECT 1 FROM "${targetTable}"`,
    `    WHERE ${linkCondition}`,
    `      AND ${matchCondition}`,
    `)`,
  ].join('\n')
}

// --- Concept ---

function buildConceptCriteria(
  config: ConceptCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (config.conceptIds.length === 0) return '1=1'
  if (!validateIntegerIds(config.conceptIds)) return '1=1'
  const eventTables = mapping.eventTables
  if (!eventTables) return '1=1'
  const et: EventTable | undefined = eventTables[config.eventTableLabel]
  if (!et) return '1=1'

  const ids = config.conceptIds.join(', ')
  const patientIdCol = getPatientIdColumn(level, mapping)
  if (!patientIdCol) return '1=1'

  // Build concept match condition
  let conceptMatch = `e."${et.conceptIdColumn}" IN (${ids})`
  if (et.sourceConceptIdColumn) {
    conceptMatch = `(${conceptMatch} OR e."${et.sourceConceptIdColumn}" IN (${ids}))`
  }

  // Build additional conditions
  const conditions: string[] = [conceptMatch]

  // Link to base table patient
  conditions.push(`e."${et.patientIdColumn ?? patientIdCol}" = "${baseTable}"."${patientIdCol}"`)

  // Multiple value filters (ANDed together)
  if (config.valueFilters && config.valueFilters.length > 0 && et.valueColumn) {
    for (const vf of config.valueFilters) {
      if (vf.operator === 'between' && vf.value2 != null) {
        conditions.push(`e."${et.valueColumn}" BETWEEN ${vf.value} AND ${vf.value2}`)
      } else {
        conditions.push(`e."${et.valueColumn}" ${vf.operator} ${vf.value}`)
      }
    }
  }

  // Legacy single valueFilter support (for existing saved cohorts)
  const legacyVf = (config as Record<string, unknown>).valueFilter as { operator: string; value: number; value2?: number } | undefined
  if (legacyVf && et.valueColumn && (!config.valueFilters || config.valueFilters.length === 0)) {
    if (legacyVf.operator === 'between' && legacyVf.value2 != null) {
      conditions.push(`e."${et.valueColumn}" BETWEEN ${legacyVf.value} AND ${legacyVf.value2}`)
    } else {
      conditions.push(`e."${et.valueColumn}" ${legacyVf.operator} ${legacyVf.value}`)
    }
  }

  const whereStr = conditions.join('\n      AND ')

  // Occurrence count → IN subquery with GROUP BY + HAVING
  if (config.occurrenceCount) {
    const oc = config.occurrenceCount
    const pidCol = et.patientIdColumn ?? patientIdCol
    return [
      `"${baseTable}"."${patientIdCol}" IN (`,
      `    SELECT e."${pidCol}"`,
      `    FROM "${et.table}" e`,
      `    WHERE ${whereStr}`,
      `    GROUP BY e."${pidCol}"`,
      `    HAVING COUNT(*) ${oc.operator} ${oc.count}`,
      `)`,
    ].join('\n')
  }

  // Simple existence
  return [
    `EXISTS (`,
    `    SELECT 1`,
    `    FROM "${et.table}" e`,
    `    WHERE ${whereStr}`,
    `)`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// FROM clause builder
// ---------------------------------------------------------------------------

/**
 * Build the FROM clause, adding JOINs as needed for patient table access.
 */
function buildFromClause(
  level: CohortLevel,
  mapping: SchemaMapping,
  tree: CriteriaGroupNode | null,
  baseTable: string,
): string {
  const parts = [`"${baseTable}"`]

  // Join patient table when querying visit/visit_detail level and criteria need patient data
  const pt = mapping.patientTable
  if (level !== 'patient' && pt && tree && needsPatientJoin(tree)) {
    const patientIdCol = getPatientIdColumn(level, mapping) ?? pt.idColumn
    parts.push(
      `INNER JOIN "${pt.table}" p\n    ON "${baseTable}"."${patientIdCol}" = p."${pt.idColumn}"`,
    )
  }

  return parts.join('\n  ')
}

/** Check if any criterion in the tree needs patient table access */
function needsPatientJoin(node: CriteriaTreeNode): boolean {
  if (!node.enabled) return false
  if (node.kind === 'criterion') {
    return node.type === 'age' || node.type === 'sex' || node.type === 'death'
  }
  return node.children.some(needsPatientJoin)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseTable(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return mapping.patientTable?.table ?? null
    case 'visit':
      return mapping.visitTable?.table ?? null
    case 'visit_detail':
      return mapping.visitDetailTable?.table ?? null
  }
}

function getIdColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return mapping.patientTable?.idColumn ?? null
    case 'visit':
      return mapping.visitTable?.idColumn ?? null
    case 'visit_detail':
      return mapping.visitDetailTable?.idColumn ?? null
  }
}

function getPatientIdColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return mapping.patientTable?.idColumn ?? null
    case 'visit':
      return mapping.visitTable?.patientIdColumn ?? null
    case 'visit_detail':
      return mapping.visitDetailTable?.patientIdColumn ?? null
  }
}

function getStartDateColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return null
    case 'visit':
      return mapping.visitTable?.startDateColumn ?? null
    case 'visit_detail':
      return mapping.visitDetailTable?.startDateColumn ?? null
  }
}

function getEndDateColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return null
    case 'visit':
      return mapping.visitTable?.endDateColumn ?? null
    case 'visit_detail':
      return mapping.visitDetailTable?.endDateColumn ?? null
  }
}

/**
 * Build a link condition for a subquery from baseTable to targetTable.
 * Handles all combinations: patient→visit, patient→visit_detail, visit→visit_detail, visit_detail→visit.
 */
function buildSubqueryLink(
  cohortLevel: CohortLevel,
  targetLevel: 'visit' | 'visit_detail',
  mapping: SchemaMapping,
  baseTable: string,
  targetTable: string,
): string | null {
  const pt = mapping.patientTable
  const vt = mapping.visitTable
  const vdt = mapping.visitDetailTable

  if (cohortLevel === 'patient' && targetLevel === 'visit') {
    if (!pt || !vt) return null
    return `"${targetTable}"."${vt.patientIdColumn}" = "${baseTable}"."${pt.idColumn}"`
  }
  if (cohortLevel === 'patient' && targetLevel === 'visit_detail') {
    if (!pt || !vdt) return null
    return `"${targetTable}"."${vdt.patientIdColumn}" = "${baseTable}"."${pt.idColumn}"`
  }
  if (cohortLevel === 'visit' && targetLevel === 'visit_detail') {
    if (!vt || !vdt) return null
    return `"${targetTable}"."${vdt.visitIdColumn}" = "${baseTable}"."${vt.idColumn}"`
  }
  if (cohortLevel === 'visit_detail' && targetLevel === 'visit') {
    if (!vt || !vdt) return null
    return `"${targetTable}"."${vt.idColumn}" = "${baseTable}"."${vdt.visitIdColumn}"`
  }
  return null
}

/**
 * Build SELECT columns for result rows based on level.
 */
function buildSelectColumns(level: CohortLevel, mapping: SchemaMapping, baseTable: string): string {
  const cols: string[] = [`"${baseTable}"."${getIdColumn(level, mapping)}" AS id`]
  const pt = mapping.patientTable
  const gv = mapping.genderValues

  // Patient ID (for visit/visit_detail levels)
  if (level !== 'patient') {
    const patientIdCol = getPatientIdColumn(level, mapping)
    if (patientIdCol) cols.push(`"${baseTable}"."${patientIdCol}" AS patient_id`)
  }

  // Gender — use CASE WHEN to show human-readable labels from genderValues mapping
  if (pt?.genderColumn) {
    const ref = level === 'patient' ? `"${baseTable}"` : 'p'
    if (gv) {
      const cases: string[] = []
      cases.push(`WHEN ${ref}."${pt.genderColumn}" = '${escSql(gv.male)}' THEN 'Male'`)
      cases.push(`WHEN ${ref}."${pt.genderColumn}" = '${escSql(gv.female)}' THEN 'Female'`)
      if (gv.unknown) cases.push(`WHEN ${ref}."${pt.genderColumn}" = '${escSql(gv.unknown)}' THEN 'Unknown'`)
      cols.push(`CASE ${cases.join(' ')} ELSE CAST(${ref}."${pt.genderColumn}" AS TEXT) END AS gender`)
    } else {
      cols.push(`${ref}."${pt.genderColumn}" AS gender`)
    }
  }

  // Age at admission (not current age) — use visit start date when available
  if (pt?.birthDateColumn || pt?.birthYearColumn) {
    const ref = level === 'patient' ? `"${baseTable}"` : 'p'

    // Determine the date reference for age calculation
    let dateRef: string
    let ageLabel: string

    if (level === 'patient') {
      // Patient level: use earliest visit start date
      const vt = mapping.visitTable
      if (vt?.startDateColumn) {
        dateRef = `(SELECT MIN("${vt.startDateColumn}") FROM "${vt.table}" WHERE "${vt.table}"."${vt.patientIdColumn}" = "${baseTable}"."${pt.idColumn}")`
        ageLabel = 'age_at_admission'
      } else {
        dateRef = 'CURRENT_DATE'
        ageLabel = 'age_current'
      }
    } else {
      const startDateCol = getStartDateColumn(level, mapping)
      if (startDateCol) {
        dateRef = `"${baseTable}"."${startDateCol}"`
        ageLabel = 'age_at_admission'
      } else {
        dateRef = 'CURRENT_DATE'
        ageLabel = 'age_current'
      }
    }

    if (pt.birthDateColumn) {
      cols.push(`DATE_PART('year', ${dateRef}) - DATE_PART('year', ${ref}."${pt.birthDateColumn}") AS ${ageLabel}`)
    } else if (pt.birthYearColumn) {
      cols.push(`DATE_PART('year', ${dateRef}::TIMESTAMP) - ${ref}."${pt.birthYearColumn}" AS ${ageLabel}`)
    }
  }

  // Start/end dates (for visit/visit_detail)
  const startCol = getStartDateColumn(level, mapping)
  const endCol = getEndDateColumn(level, mapping)
  if (startCol) cols.push(`"${baseTable}"."${startCol}" AS start_date`)
  if (endCol) cols.push(`"${baseTable}"."${endCol}" AS end_date`)

  return cols.join(',\n  ')
}

/** Human-readable label for a criteria tree node (for attrition chart). */
export function getNodeLabel(node: CriteriaTreeNode): string {
  if (node.kind === 'group') {
    return node.label ?? `Group (${node.operator})`
  }
  const prefix = node.exclude ? 'NOT ' : ''
  switch (node.type) {
    case 'age': {
      const c = node.config as AgeCriteriaConfig
      const parts: string[] = []
      if (c.min != null) parts.push(`>= ${c.min}`)
      if (c.max != null) parts.push(`<= ${c.max}`)
      return `${prefix}Age ${parts.join(' & ')}`
    }
    case 'sex': {
      const c = node.config as SexCriteriaConfig
      return `${prefix}Sex: ${c.values.join(', ')}`
    }
    case 'death': {
      const c = node.config as DeathCriteriaConfig
      return `${prefix}${c.isDead ? 'Deceased' : 'Alive'}`
    }
    case 'period': {
      const c = node.config as PeriodCriteriaConfig
      const parts: string[] = []
      if (c.startDate) parts.push(`from ${c.startDate}`)
      if (c.endDate) parts.push(`to ${c.endDate}`)
      return `${prefix}Period ${parts.join(' ')}`
    }
    case 'duration': {
      const c = node.config as DurationCriteriaConfig
      const unitSuffix = c.durationUnit === 'hours' ? 'h' : 'd'
      const parts: string[] = []
      if (c.minDays != null) parts.push(`>= ${c.minDays}${unitSuffix}`)
      if (c.maxDays != null) parts.push(`<= ${c.maxDays}${unitSuffix}`)
      const levelLabel = c.durationLevel === 'visit_detail' ? 'unit' : 'visit'
      return `${prefix}Duration (${levelLabel}) ${parts.join(' & ')}`
    }
    case 'care_site': {
      const c = node.config as CareSiteCriteriaConfig
      return `${prefix}Care site: ${c.values.join(', ')}`
    }
    case 'concept': {
      const c = node.config as ConceptCriteriaConfig
      const names = Object.values(c.conceptNames)
      const label = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1}`
      return `${prefix}${c.eventTableLabel}: ${label}`
    }
    case 'text':
      return `${prefix}(free text)`
    default:
      return 'Unknown'
  }
}
