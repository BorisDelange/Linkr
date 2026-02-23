import type {
  Cohort,
  CohortLevel,
  CriteriaTreeNode,
  CriterionNode,
  CriteriaGroupNode,
  AgeCriteriaConfig,
  SexCriteriaConfig,
  DeathCriteriaConfig,
  PeriodCriteriaConfig,
  DurationCriteriaConfig,
  VisitTypeCriteriaConfig,
  ConceptCriteriaConfig,
} from '@/types'
import type { SchemaMapping, EventTable } from '@/types'

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
    whereClause: where && where !== '1=1' ? `WHERE ${where}` : '',
  }
}

/**
 * Build a COUNT(DISTINCT id) query from a Cohort definition.
 */
export function buildCohortCountSql(cohort: Cohort, mapping: SchemaMapping): string | null {
  const parts = buildCohortQueryParts(cohort, mapping)
  if (!parts) return null
  return `SELECT COUNT(DISTINCT "${parts.baseTable}"."${parts.idColumn}") AS cnt FROM ${parts.from} ${parts.whereClause}`
}

/** @deprecated Use buildCohortCountSql instead */
export const buildCohortQuery = buildCohortCountSql

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
  return `SELECT DISTINCT ${selectCols} FROM ${parts.from} ${parts.whereClause} ORDER BY "${parts.baseTable}"."${parts.idColumn}" LIMIT ${limit} OFFSET ${offset}`
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
    sql: `SELECT COUNT(DISTINCT "${baseTable}"."${idColumn}") AS cnt FROM ${baseFrom}`,
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
    const whereStr = where && where !== '1=1' ? `WHERE ${where}` : ''
    queries.push({
      nodeId: enabledChildren[i].id,
      label: getNodeLabel(enabledChildren[i]),
      sql: `SELECT COUNT(DISTINCT "${baseTable}"."${idColumn}") AS cnt FROM ${from} ${whereStr}`,
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

  // Group node
  const childClauses = node.children
    .map((child) => buildTreeWhereClause(child, level, mapping, baseTable))
    .filter((c) => c !== '1=1')

  if (childClauses.length === 0) return '1=1'

  const joined =
    childClauses.length === 1
      ? childClauses[0]
      : childClauses.map((c) => `(${c})`).join(` ${node.operator} `)

  return node.exclude ? `NOT (${joined})` : joined
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
    case 'visit_type':
      return buildVisitTypeCriteria(criterion.config as VisitTypeCriteriaConfig, level, mapping, baseTable)
    case 'concept':
      return buildConceptCriteria(criterion.config as ConceptCriteriaConfig, level, mapping, baseTable)
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
  if (config.ageReference === 'admission' && level !== 'patient') {
    const startDateCol = getStartDateColumn(level, mapping)
    dateRef = startDateCol ? `"${baseTable}"."${startDateCol}"` : 'CURRENT_DATE'
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
  return parts.join(' AND ') || '1=1'
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
  const vals = config.values.map((v) => `'${v}'`).join(', ')
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
  const startDateCol = getStartDateColumn(level, mapping)
  if (!startDateCol) return '1=1'
  const dateRef = `"${baseTable}"."${startDateCol}"`
  const parts: string[] = []
  if (config.startDate) parts.push(`${dateRef} >= '${config.startDate}'`)
  if (config.endDate) parts.push(`${dateRef} <= '${config.endDate}'`)
  return parts.join(' AND ') || '1=1'
}

// --- Duration ---

function buildDurationCriteria(
  config: DurationCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  const startCol = getStartDateColumn(level, mapping)
  const endCol = getEndDateColumn(level, mapping)
  if (!startCol || !endCol) return '1=1'
  const durExpr = `DATE_DIFF('day', "${baseTable}"."${startCol}", "${baseTable}"."${endCol}")`
  const parts: string[] = []
  if (config.minDays != null) parts.push(`${durExpr} >= ${config.minDays}`)
  if (config.maxDays != null) parts.push(`${durExpr} <= ${config.maxDays}`)
  return parts.join(' AND ') || '1=1'
}

// --- Visit Type ---

function buildVisitTypeCriteria(
  config: VisitTypeCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (config.values.length === 0) return '1=1'
  const typeCol = getTypeColumn(level, mapping)
  if (!typeCol) return '1=1'
  const vals = config.values.map((v) => `'${v}'`).join(', ')
  return `"${baseTable}"."${typeCol}" IN (${vals})`
}

// --- Concept ---

function buildConceptCriteria(
  config: ConceptCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (config.conceptIds.length === 0) return '1=1'
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

  // Value filter
  if (config.valueFilter && et.valueColumn) {
    const vf = config.valueFilter
    if (vf.operator === 'between' && vf.value2 != null) {
      conditions.push(`e."${et.valueColumn}" BETWEEN ${vf.value} AND ${vf.value2}`)
    } else {
      conditions.push(`e."${et.valueColumn}" ${vf.operator} ${vf.value}`)
    }
  }

  // Time window
  if (config.timeWindow && et.dateColumn) {
    const startDateCol = getStartDateColumn(level, mapping)
    if (startDateCol) {
      if (config.timeWindow.daysBefore != null) {
        conditions.push(
          `e."${et.dateColumn}" >= "${baseTable}"."${startDateCol}" - INTERVAL '${config.timeWindow.daysBefore} days'`,
        )
      }
      if (config.timeWindow.daysAfter != null) {
        conditions.push(
          `e."${et.dateColumn}" <= "${baseTable}"."${startDateCol}" + INTERVAL '${config.timeWindow.daysAfter} days'`,
        )
      }
    }
  }

  const whereStr = conditions.join(' AND ')

  // Occurrence count → IN subquery with GROUP BY + HAVING
  if (config.occurrenceCount) {
    const oc = config.occurrenceCount
    return `"${baseTable}"."${patientIdCol}" IN (SELECT e."${et.patientIdColumn ?? patientIdCol}" FROM "${et.table}" e WHERE ${whereStr} GROUP BY e."${et.patientIdColumn ?? patientIdCol}" HAVING COUNT(*) ${oc.operator} ${oc.count})`
  }

  // Simple existence
  return `EXISTS (SELECT 1 FROM "${et.table}" e WHERE ${whereStr})`
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
  let from = `"${baseTable}"`

  // Join patient table when querying visit/visit_detail level and criteria need patient data
  const pt = mapping.patientTable
  if (level !== 'patient' && pt && tree && needsPatientJoin(tree)) {
    const patientIdCol = getPatientIdColumn(level, mapping) ?? pt.idColumn
    from += ` INNER JOIN "${pt.table}" p ON "${baseTable}"."${patientIdCol}" = p."${pt.idColumn}"`
  }

  // Join visit table when querying visit_detail level and criteria need visit data
  if (level === 'visit_detail' && mapping.visitTable && tree && needsVisitJoin(tree)) {
    const vdt = mapping.visitDetailTable
    const vt = mapping.visitTable
    if (vdt && vt) {
      from += ` INNER JOIN "${vt.table}" v ON "${baseTable}"."${vdt.visitIdColumn}" = v."${vt.idColumn}"`
    }
  }

  return from
}

/** Check if any criterion in the tree needs patient table access */
function needsPatientJoin(node: CriteriaTreeNode): boolean {
  if (!node.enabled) return false
  if (node.kind === 'criterion') {
    return node.type === 'age' || node.type === 'sex' || node.type === 'death'
  }
  return node.children.some(needsPatientJoin)
}

/** Check if any criterion in the tree needs visit table access (for visit_detail level) */
function needsVisitJoin(node: CriteriaTreeNode): boolean {
  if (!node.enabled) return false
  if (node.kind === 'criterion') {
    return node.type === 'visit_type'
  }
  return node.children.some(needsVisitJoin)
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

function getTypeColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return null
    case 'visit':
      return mapping.visitTable?.typeColumn ?? null
    case 'visit_detail':
      return mapping.visitDetailTable?.unitColumn ?? null
  }
}

/**
 * Build SELECT columns for result rows based on level.
 */
function buildSelectColumns(level: CohortLevel, mapping: SchemaMapping, baseTable: string): string {
  const cols: string[] = [`"${baseTable}"."${getIdColumn(level, mapping)}" AS id`]
  const pt = mapping.patientTable

  // Patient ID (for visit/visit_detail levels)
  if (level !== 'patient') {
    const patientIdCol = getPatientIdColumn(level, mapping)
    if (patientIdCol) cols.push(`"${baseTable}"."${patientIdCol}" AS patient_id`)
  }

  // Gender
  if (pt?.genderColumn) {
    const ref = level === 'patient' ? `"${baseTable}"` : 'p'
    cols.push(`${ref}."${pt.genderColumn}" AS gender`)
  }

  // Age
  if (pt?.birthDateColumn || pt?.birthYearColumn) {
    const ref = level === 'patient' ? `"${baseTable}"` : 'p'
    if (pt.birthDateColumn) {
      cols.push(`DATE_PART('year', CURRENT_DATE) - DATE_PART('year', ${ref}."${pt.birthDateColumn}") AS age`)
    } else if (pt.birthYearColumn) {
      cols.push(`DATE_PART('year', CURRENT_TIMESTAMP) - ${ref}."${pt.birthYearColumn}" AS age`)
    }
  }

  // Start/end dates (for visit/visit_detail)
  const startCol = getStartDateColumn(level, mapping)
  const endCol = getEndDateColumn(level, mapping)
  if (startCol) cols.push(`"${baseTable}"."${startCol}" AS start_date`)
  if (endCol) cols.push(`"${baseTable}"."${endCol}" AS end_date`)

  return cols.join(', ')
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
      const parts: string[] = []
      if (c.minDays != null) parts.push(`>= ${c.minDays}d`)
      if (c.maxDays != null) parts.push(`<= ${c.maxDays}d`)
      return `${prefix}Duration ${parts.join(' & ')}`
    }
    case 'visit_type': {
      const c = node.config as VisitTypeCriteriaConfig
      return `${prefix}Visit type: ${c.values.join(', ')}`
    }
    case 'concept': {
      const c = node.config as ConceptCriteriaConfig
      const names = Object.values(c.conceptNames)
      const label = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1}`
      return `${prefix}${c.eventTableLabel}: ${label}`
    }
    default:
      return 'Unknown'
  }
}
