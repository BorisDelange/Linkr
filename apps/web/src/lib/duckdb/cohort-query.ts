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
  TextCriteriaConfig,
  TextMatchMode,
} from '@/types'
import type { SchemaMapping } from '@/types'
import { escSql, validateIntegerIds } from '@/lib/format-helpers'
import { classRelation, eventRelation, has, type ClassRelation } from '@/lib/schema-classes/relations'

// ---------------------------------------------------------------------------
// Untrusted-input guards
// ---------------------------------------------------------------------------
//
// A cohort's criteria are NOT developer-authored config: `importProjectZip`
// JSON.parses `cohorts/*.json` straight into storage with no schema validation,
// so every field here can be attacker-supplied. The forms coerce with Number()
// and constrain the operators to their unions, but an imported cohort bypasses
// the forms entirely. `conceptIds` was already guarded (validateIntegerIds);
// these cover the rest of the values that reach SQL unquoted.

/** A finite number safe to interpolate into SQL, or null if it is anything else. */
function sqlNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const VALUE_FILTER_OPERATORS = new Set(['>', '>=', '=', '<=', '<', '!=', 'between'])
const COUNT_OPERATORS = new Set(['>=', '>', '=', '<=', '<'])

/** A comparison operator from the declared union, or null. Never interpolate the
 *  stored string directly: `IS NOT NULL OR 1=1 --` is a valid JSON string. */
function sqlOperator(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null
}

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
export function buildCohortQueryParts(
  cohort: Cohort,
  mapping: SchemaMapping,
  /** Force the patient join even when no criterion needs it. The results SELECT
   *  reads gender/age through the `p` alias, so at visit level it must be joined
   *  regardless of the criteria — otherwise the query is built referencing a
   *  table that isn't in the FROM. */
  forcePatientJoin = false,
): CohortQueryParts | null {
  const baseTable = getBaseTable(cohort.level, mapping)
  const idColumn = getIdColumn(cohort.level, mapping)
  if (!baseTable || !idColumn) return null

  const where = buildTreeWhereClause(cohort.criteriaTree, cohort.level, mapping, baseTable)
  const from = buildFromClause(
    cohort.level,
    mapping,
    cohort.criteriaTree,
    baseTable,
    forcePatientJoin,
  )

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
    `  COUNT(DISTINCT ${parts.baseTable}.${parts.idColumn}) AS cnt`,
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
  // The result columns read gender/age off the patient table through `p`, which
  // the criteria alone may not have joined (a concept-only cohort at visit level
  // used to build `p."gender_concept_id"` with no `p` in the FROM — the count
  // succeeded and only this query failed).
  const needsPatient =
    cohort.level !== 'patient' && selectNeedsPatientAlias(mapping)
  const parts = buildCohortQueryParts(cohort, mapping, needsPatient)
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
    `  ${parts.baseTable}.${parts.idColumn}`,
    `LIMIT ${limit}`,
    `OFFSET ${offset}`,
  )
  return lines.join('\n')
}

/**
 * Build a query returning the full cohort membership (no LIMIT) for materialization.
 * Returns two columns: `id` (level id) and `patient_id`. At patient level the two
 * are identical. Event level has no single base table, so it returns null.
 */
export function buildCohortMembershipSql(cohort: Cohort, mapping: SchemaMapping): string | null {
  if (cohort.level === 'event') return null
  const parts = buildCohortQueryParts(cohort, mapping)
  if (!parts) return null

  const lines = [
    `SELECT DISTINCT`,
    `  ${parts.baseTable}.${parts.idColumn} AS id,`,
    `  ${parts.baseTable}.patient_id AS patient_id`,
    `FROM`,
    `  ${parts.from}`,
  ]
  if (parts.whereClause) {
    lines.push(`WHERE`, `  ${parts.whereClause}`)
  }
  return lines.join('\n')
}

/**
 * Build attrition queries: one COUNT per top-level child, progressively accumulated.
 */
export function buildAttritionQueries(
  cohort: Cohort,
  mapping: SchemaMapping,
  /** Also count the distinct patients at each step (`patients` column), beside
   *  the level's own ids (`cnt`) — the cohort report's flowchart shows both. */
  opts: { withPatients?: boolean } = {},
): { nodeId: string; label: string; sql: string }[] {
  const baseTable = getBaseTable(cohort.level, mapping)
  const idColumn = getIdColumn(cohort.level, mapping)
  if (!baseTable || !idColumn) return []
  const countCols = opts.withPatients
    ? `  COUNT(DISTINCT ${baseTable}.${idColumn}) AS cnt,\n  COUNT(DISTINCT ${baseTable}.patient_id) AS patients`
    : `  COUNT(DISTINCT ${baseTable}.${idColumn}) AS cnt`

  const queries: { nodeId: string; label: string; sql: string }[] = []

  // Base FROM clause without criteria-dependent joins
  const baseFrom = buildFromClause(cohort.level, mapping, null, baseTable)

  // Total without any criteria
  queries.push({
    nodeId: '__total__',
    label: 'Total',
    sql: [
      `SELECT`,
      countCols,
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
      countCols,
      `FROM`,
      `  ${from}`,
    ]
    if (where && where !== '1=1') {
      lines.push(`WHERE`, `  ${where}`)
    }
    queries.push({
      nodeId: enabledChildren[i].id,
      label: getNodeLabel(enabledChildren[i], mapping),
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
      return buildDeathCriteria(criterion.config as DeathCriteriaConfig, level, mapping, baseTable)
    case 'period':
      return buildPeriodCriteria(criterion.config as PeriodCriteriaConfig, level, mapping, baseTable)
    case 'duration':
      return buildDurationCriteria(criterion.config as DurationCriteriaConfig, level, mapping, baseTable)
    case 'care_site':
      return buildCareSiteCriteria(criterion.config as CareSiteCriteriaConfig, level, mapping, baseTable)
    case 'concept':
      return buildConceptCriteria(criterion.config as ConceptCriteriaConfig, level, mapping, baseTable)
    case 'text':
      return buildTextCriteria(criterion.config as TextCriteriaConfig, level, mapping, baseTable)
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
  const patient = classRelation(mapping, 'patient')
  if (!patient) return '1=1'

  const personRef = level === 'patient' ? patient.name : 'p'

  let dateRef: string
  if (config.ageReference === 'admission') {
    if (level === 'patient') {
      // Patient level: use earliest visit start date via subquery
      const visit = classRelation(mapping, 'visit')
      dateRef = visit
        ? `(SELECT MIN(start_datetime) FROM ${visit.name} WHERE ${visit.name}.patient_id = ${patient.name}.patient_id)`
        : 'CURRENT_DATE'
    } else {
      const startDateCol = getStartDateColumn(level, mapping)
      dateRef = startDateCol ? `${baseTable}.${startDateCol}` : 'CURRENT_DATE'
    }
  } else {
    dateRef = 'CURRENT_DATE'
  }

  // In days or months the birth YEAR is far too coarse to answer the question
  // (a neonatology filter needs the date), so those units require the date
  // column; years uses the birth year, which already falls back from the date.
  const unit = config.ageUnit ?? 'years'
  let ageExpr: string
  if (unit === 'years') {
    if (!has(patient, 'birth_year')) return '1=1'
    ageExpr = `DATE_PART('year', ${dateRef}::TIMESTAMP) - ${personRef}.birth_year`
  } else {
    if (!has(patient, 'birth_date')) return '1=1'
    ageExpr = `DATE_DIFF('${unit === 'days' ? 'day' : 'month'}', ${personRef}.birth_date::TIMESTAMP, ${dateRef}::TIMESTAMP)`
  }

  const min = sqlNumber(config.min)
  const max = sqlNumber(config.max)
  const parts: string[] = []
  if (min != null) parts.push(`${ageExpr} >= ${min}`)
  if (max != null) parts.push(`${ageExpr} <= ${max}`)
  return parts.length > 0 ? `(${parts.join(' AND\n    ')})` : '1=1'
}

/**
 * Whether an age criterion can be answered at all by this mapping. In days or
 * months the birth *year* is too coarse (a neonatology filter needs the date),
 * so a mapping carrying only a year cannot express the question — on MIMIC-IV,
 * where `birth_datetime` is NULL for every patient, such a criterion silently
 * matched nobody while the results table went on displaying ages. The builder
 * still emits the honest clause; the UI uses this to say so out loud.
 */
export function ageCriterionUnsatisfiable(
  config: AgeCriteriaConfig,
  mapping: SchemaMapping,
): boolean {
  if ((config.ageUnit ?? 'years') === 'years') return false
  return !has(classRelation(mapping, 'patient'), 'birth_date')
}

// --- Sex ---

function buildSexCriteria(
  config: SexCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
): string {
  if (config.values.length === 0) return '1=1'
  const patient = classRelation(mapping, 'patient')
  // Saved cohorts hold the source's own codes ('8507', 'M'), not the normalised
  // gender, so they are matched against the source value.
  if (!has(patient, 'gender_source_value')) return '1=1'
  const personRef = level === 'patient' ? patient!.name : 'p'
  const vals = config.values.map((v) => `'${escSql(v)}'`).join(', ')
  return `${personRef}.gender_source_value IN (${vals})`
}

// --- Death ---

function buildDeathCriteria(
  config: DeathCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  const patient = classRelation(mapping, 'patient')
  if (!has(patient, 'death_datetime')) return '1=1'
  const personRef = level === 'patient' ? patient!.name : 'p'

  const deathCol = `${personRef}.death_datetime`
  if (!config.isDead) return `${deathCol} IS NULL`

  // 'any' (and the patient level, which has no stay to bound it) just asks
  // whether a death is recorded at all. The other references additionally
  // require it to fall inside the stay being selected — without that window
  // "died during this unit stay" matched anyone who ever died.
  const ref = config.deathReference ?? 'any'
  if (ref === 'any' || level === 'patient') return `${deathCol} IS NOT NULL`

  const window = classRelation(mapping, ref === 'visit' ? 'visit' : 'visit_detail')
  if (!window || !has(window, 'end_datetime')) return `${deathCol} IS NOT NULL`
  // At the level being queried the window is the base row itself; otherwise it
  // is looked up through the patient.
  if (ref === level) {
    return `${deathCol} IS NOT NULL AND ${deathCol} BETWEEN ${baseTable}.start_datetime AND ${baseTable}.end_datetime`
  }
  return `${deathCol} IS NOT NULL AND EXISTS (SELECT 1 FROM ${window.name} w WHERE w.patient_id = ${baseTable}.patient_id AND ${deathCol} BETWEEN w.start_datetime AND w.end_datetime)`
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
    const visit = classRelation(mapping, 'visit')
    if (!visit) return '1=1'
    const conditions: string[] = []
    if (config.startDate) conditions.push(`start_datetime >= '${escSql(config.startDate)}'`)
    if (config.endDate) conditions.push(`start_datetime <= '${escSql(config.endDate)}'`)
    return [
      `EXISTS (`,
      `    SELECT 1 FROM ${visit.name}`,
      `    WHERE ${visit.name}.patient_id = ${baseTable}.patient_id`,
      `      AND ${conditions.join(' AND ')}`,
      `)`,
    ].join('\n')
  }

  const startDateCol = getStartDateColumn(level, mapping)
  if (!startDateCol) return '1=1'
  const dateRef = `${baseTable}.${startDateCol}`
  const parts: string[] = []
  if (config.startDate) parts.push(`${dateRef} >= '${escSql(config.startDate)}'`)
  if (config.endDate) parts.push(`${dateRef} <= '${escSql(config.endDate)}'`)
  return parts.join(' AND ') || '1=1'
}

// --- Duration ---

// --- Free text (clinical notes) ---

/** Escape the characters LIKE treats as wildcards, so a term is matched
 *  literally. Quote the result with escPatternLiteral, NOT escSql. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Quote an already-escaped pattern (regex or LIKE) for SQL. Unlike escSql this
 * must NOT double backslashes: they are meaningful to the regex engine and to
 * the LIKE ESCAPE clause, and doubling them turns `\b` into a literal
 * backslash-b, or `\%` into an escaped backslash followed by a live wildcard —
 * both of which match nothing. Only the quote (and NUL) need handling.
 */
export function escPatternLiteral(pattern: string): string {
  return pattern.replace(/'/g, "''").replace(/\0/g, '')
}

/** One term against one column, in the requested matching mode. */
function textTermClause(colRef: string, term: string, mode: TextMatchMode): string {
  if (mode === 'regex') {
    // The pattern is the user's own; `(?i)` makes it case-insensitive to match
    // the other two modes rather than surprising them with case sensitivity.
    return `regexp_matches(${colRef}, '${escPatternLiteral(`(?i)${term}`)}')`
  }
  if (mode === 'word') {
    // \b is the word boundary DuckDB's RE2 engine understands (\y, the Postgres
    // spelling, raises "invalid escape sequence") — keeps "art" off "artère".
    return `regexp_matches(${colRef}, '${escPatternLiteral(`(?i)\\b${escapeRegex(term)}\\b`)}')`
  }
  // escapeLikeTerm already added the LIKE escapes; running escSql over them
  // would double those backslashes and break the escape, so a term containing
  // "%" matched nothing at all. Only the quote still needs handling.
  return `${colRef} ILIKE '${escPatternLiteral(`%${escapeLikeTerm(term)}%`)}' ESCAPE '\\'`
}

/** Neutralize regex metacharacters in a term used for whole-word matching. */
function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Free-text search over the mapped note table. Each configured field search is
 * ANDed with the others, so one block can require a word in the title and a
 * different one in the body.
 */
function buildTextCriteria(
  config: TextCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  const searches = (config.searches ?? []).filter((s) => s.terms.some((t) => t.trim()))
  // With nothing to search on this stays descriptive, as it was before.
  if (searches.length === 0) return '1=1'

  const note = classRelation(mapping, 'note')
  if (!note) return '1=1'

  const conditions: { clause: string; operator: CriteriaOperator }[] = []
  for (const search of searches) {
    const column = search.field === 'title' ? 'title' : 'text'
    // A title search on a mapping without a title column would silently widen
    // the criterion to every note, so it is dropped instead.
    if (!has(note, column)) continue
    const colRef = `n.${column}`
    const terms = search.terms.map((t) => t.trim()).filter(Boolean)
    if (terms.length === 0) continue
    const mode = search.mode ?? 'contains'
    const clauses = terms.map((term) => textTermClause(colRef, term, mode))
    const joined = clauses.join(search.anyTerm === false ? ' AND ' : ' OR ')
    const grouped = clauses.length > 1 ? `(${joined})` : joined
    conditions.push({
      clause: search.exclude ? `NOT (${grouped})` : grouped,
      operator: search.operator ?? 'AND',
    })
  }
  if (conditions.length === 0) return '1=1'
  // Same AND > OR precedence as the criteria tree, so the two read alike.
  const combined = buildPrecedenceClause(conditions)

  // Notes hang off the patient; at visit level, narrow to the visit when the
  // mapping says which visit a note belongs to, else to the stay's dates.
  const links = [`n.patient_id = ${baseTable}.patient_id`]
  if (level === 'visit' && has(note, 'visit_id')) {
    links.push(`n.visit_id = ${baseTable}.visit_id`)
  } else {
    const window = stayWindowClause(level, mapping, baseTable, 'n.note_datetime')
    if (window) links.push(window)
  }

  return `EXISTS (SELECT 1 FROM ${note.name} n WHERE ${links.join(' AND ')} AND (${combined}))`
}

function buildDurationCriteria(
  config: DurationCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  // Bounds are only usable if they are real numbers — an imported cohort can
  // carry anything here, and both reach SQL unquoted.
  const minDays = sqlNumber(config.minDays)
  const maxDays = sqlNumber(config.maxDays)
  if (minDays == null && maxDays == null) return '1=1'

  const targetLevel = config.durationLevel ?? 'visit'
  const datePart =
    config.durationUnit === 'hours' ? 'hour' : config.durationUnit === 'months' ? 'month' : 'day'

  const targetTable = getBaseTable(targetLevel, mapping)
  if (!targetTable || !getEndDateColumn(targetLevel, mapping)) return '1=1'

  // If the target level matches the cohort level, filter directly
  if (targetLevel === level) {
    const durExpr = `DATE_DIFF('${datePart}', ${baseTable}.start_datetime, ${baseTable}.end_datetime)`
    const parts: string[] = []
    if (minDays != null) parts.push(`${durExpr} >= ${minDays}`)
    if (maxDays != null) parts.push(`${durExpr} <= ${maxDays}`)
    // Wrapped so the clause survives being placed in an OR group, and so an
    // empty join can never produce a bare `` in the WHERE.
    return parts.length > 0 ? `(${parts.join(' AND ')})` : '1=1'
  }

  // Otherwise use a subquery (e.g. patient level filtering on visit duration)
  const durExpr = `DATE_DIFF('${datePart}', ${targetTable}.start_datetime, ${targetTable}.end_datetime)`
  const durConditions: string[] = []
  if (minDays != null) durConditions.push(`${durExpr} >= ${minDays}`)
  if (maxDays != null) durConditions.push(`${durExpr} <= ${maxDays}`)
  if (durConditions.length === 0) return '1=1'

  // Link target to base table
  const linkCondition = buildSubqueryLink(level, targetLevel, baseTable, targetTable)
  if (!linkCondition) return '1=1'

  return [
    `EXISTS (`,
    `    SELECT 1 FROM ${targetTable}`,
    `    WHERE ${linkCondition}`,
    `      AND ${durConditions.join(' AND ')}`,
    `)`,
  ].join('\n')
}

// --- Care Site ---

/**
 * The column a care-site criterion compares its values with. The picker lists
 * the looked-up names when the mapping has a lookup, else the raw codes — at
 * the stay level that is exactly `unit_category`.
 */
export function careSiteColumn(rel: ClassRelation | undefined): string | null {
  if (!rel) return null
  if (rel.cls === 'visit') {
    if (has(rel, 'care_site_name')) return 'care_site_name'
    return has(rel, 'care_site_id') ? 'care_site_id' : null
  }
  return has(rel, 'unit_category') ? 'unit_category' : null
}

function buildCareSiteCriteria(
  config: CareSiteCriteriaConfig,
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
): string {
  if (config.values.length === 0) return '1=1'

  const targetLevel = config.careSiteLevel ?? 'visit_detail'
  const target = classRelation(mapping, targetLevel)
  const column = careSiteColumn(target)
  if (!target || !column) return '1=1'

  const vals = config.values.map((v) => `'${escSql(v)}'`).join(', ')
  const matchCondition = `${target.name}.${column} IN (${vals})`

  // If target level matches cohort level, filter directly
  if (targetLevel === level) {
    return matchCondition
  }

  // Otherwise use a subquery
  const linkCondition = buildSubqueryLink(level, targetLevel, baseTable, target.name)
  if (!linkCondition) return '1=1'

  return [
    `EXISTS (`,
    `    SELECT 1 FROM ${target.name}`,
    `    WHERE ${linkCondition}`,
    `      AND ${matchCondition}`,
    `)`,
  ].join('\n')
}

// --- Stay window ---

/**
 * `eventDate` falls inside the stay whose bounds are `start`..`end`. Compared at
 * day precision whenever either side carries no time (midnight, as a DATE casts):
 * an OMOP `visit_end_date` must still admit that day's 14:00 measurement, and a
 * date-only event must still count on the admission day. A NULL bound is open —
 * a stay still in progress has no end.
 */
export function withinStaySql(eventDate: string, start: string, end: string | null): string {
  const ts = (x: string) => `CAST(${x} AS TIMESTAMP)`
  const dayOnly = (x: string) => `${ts(x)} = CAST(CAST(${x} AS DATE) AS TIMESTAMP)`
  const bound = (b: string, op: '>=' | '<=') =>
    `(${b} IS NULL OR CASE WHEN ${dayOnly(eventDate)} OR ${dayOnly(b)}`
    + ` THEN CAST(${eventDate} AS DATE) ${op} CAST(${b} AS DATE) ELSE ${ts(eventDate)} ${op} ${ts(b)} END)`
  return [bound(start, '>='), ...(end ? [bound(end, '<=')] : [])].join(' AND ')
}

/**
 * At a stay level, the clause keeping an event to the stay being selected, else
 * null (patient level, or no date to compare). Without it a criterion was tied
 * to the patient only, and "stays with a lactate > 2" kept every stay of anyone
 * who ever had one.
 */
function stayWindowClause(
  level: CohortLevel,
  mapping: SchemaMapping,
  baseTable: string,
  eventDate: string | undefined,
): string | null {
  if (level !== 'visit' && level !== 'visit_detail') return null
  const start = getStartDateColumn(level, mapping)
  if (!eventDate || !start) return null
  const end = getEndDateColumn(level, mapping)
  return withinStaySql(eventDate, `${baseTable}.${start}`, end ? `${baseTable}.${end}` : null)
}

/** Whether a concept criterion on this event table can be kept to the stay at
 *  this level; false means it still matches any time in the patient's history. */
export function conceptCriterionBoundToStay(
  level: CohortLevel,
  mapping: SchemaMapping,
  eventTableLabel: string,
): boolean {
  if (level !== 'visit' && level !== 'visit_detail') return true
  return has(eventRelation(mapping, eventTableLabel), 'start_datetime') && Boolean(getStartDateColumn(level, mapping))
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
  const event = eventRelation(mapping, config.eventTableLabel)
  if (!event || !has(event, 'patient_id')) return '1=1'

  const ids = config.conceptIds.join(', ')

  // Build concept match condition
  let conceptMatch = `e.concept_id IN (${ids})`
  if (has(event, 'source_concept_id')) {
    conceptMatch = `(${conceptMatch} OR e.source_concept_id IN (${ids}))`
  }

  // Build additional conditions
  const conditions: string[] = [conceptMatch]

  // Link to base table patient
  conditions.push(`e.patient_id = ${baseTable}.patient_id`)
  const window = stayWindowClause(level, mapping, baseTable, has(event, 'start_datetime') ? 'e.start_datetime' : undefined)
  if (window) conditions.push(window)

  // Multiple value filters (ANDed together). Operator and bounds are both
  // validated: an imported cohort can put arbitrary strings in either.
  const hasValue = has(event, 'value_number')
  if (config.valueFilters && config.valueFilters.length > 0 && hasValue) {
    for (const vf of config.valueFilters) {
      const op = sqlOperator(vf.operator, VALUE_FILTER_OPERATORS)
      const value = sqlNumber(vf.value)
      if (!op || value == null) continue
      const value2 = sqlNumber(vf.value2)
      if (op === 'between' && value2 != null) {
        conditions.push(`e.value_number BETWEEN ${value} AND ${value2}`)
      } else if (op !== 'between') {
        conditions.push(`e.value_number ${op} ${value}`)
      }
    }
  }

  // Legacy single valueFilter support (for existing saved cohorts). The field
  // no longer exists on the current type, so read it through `unknown`.
  const legacyVf = (config as unknown as Record<string, unknown>).valueFilter as { operator: string; value: number; value2?: number } | undefined
  if (legacyVf && hasValue && (!config.valueFilters || config.valueFilters.length === 0)) {
    const op = sqlOperator(legacyVf.operator, VALUE_FILTER_OPERATORS)
    const value = sqlNumber(legacyVf.value)
    const value2 = sqlNumber(legacyVf.value2)
    if (op && value != null) {
      if (op === 'between' && value2 != null) {
        conditions.push(`e.value_number BETWEEN ${value} AND ${value2}`)
      } else if (op !== 'between') {
        conditions.push(`e.value_number ${op} ${value}`)
      }
    }
  }

  const whereStr = conditions.join('\n      AND ')

  // Occurrence count → IN subquery with GROUP BY + HAVING. Both halves of the
  // HAVING are validated: an unchecked `count` here closes the subquery and
  // appends arbitrary SQL (a `UNION ALL ... read_csv('http://...')` egress
  // channel), so a rejected operator or count drops the clause entirely rather
  // than falling through to an unfiltered one.
  const oc = config.occurrenceCount
  const ocOperator = sqlOperator(oc?.operator, COUNT_OPERATORS)
  const ocCount = sqlNumber(oc?.count)
  if (oc && ocOperator && ocCount != null) {
    return [
      `${baseTable}.patient_id IN (`,
      `    SELECT e.patient_id`,
      `    FROM ${event.name} e`,
      `    WHERE ${whereStr}`,
      `    GROUP BY e.patient_id`,
      `    HAVING COUNT(*) ${ocOperator} ${ocCount}`,
      `)`,
    ].join('\n')
  }

  // Simple existence
  return [
    `EXISTS (`,
    `    SELECT 1`,
    `    FROM ${event.name} e`,
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
  forcePatientJoin = false,
): string {
  const parts = [baseTable]

  // Join patient table when querying visit/visit_detail level and criteria need
  // patient data — or when the caller selects patient columns regardless.
  const patient = classRelation(mapping, 'patient')
  if (level !== 'patient' && patient && (forcePatientJoin || (tree && needsPatientJoin(tree)))) {
    parts.push(`INNER JOIN ${patient.name} p\n    ON ${baseTable}.patient_id = p.patient_id`)
  }

  return parts.join('\n  ')
}

/** Whether the result SELECT emits a `p.`-qualified column. Must stay in step
 *  with the patient-derived columns in `buildSelectColumns` (gender, age). */
function selectNeedsPatientAlias(mapping: SchemaMapping): boolean {
  const patient = classRelation(mapping, 'patient')
  return has(patient, 'gender_source_value') || has(patient, 'birth_year')
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

// 'event' has no single base table (it spans every event relation); callers
// that need one resolve it by label elsewhere.
function levelRelation(level: CohortLevel, mapping: SchemaMapping): ClassRelation | undefined {
  return level === 'event' ? undefined : classRelation(mapping, level)
}

function getBaseTable(level: CohortLevel, mapping: SchemaMapping): string | null {
  return levelRelation(level, mapping)?.name ?? null
}

function getIdColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  if (!levelRelation(level, mapping)) return null
  return level === 'patient' ? 'patient_id' : level === 'visit' ? 'visit_id' : 'visit_detail_id'
}

function getStartDateColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  if (level === 'patient') return null
  return has(levelRelation(level, mapping), 'start_datetime') ? 'start_datetime' : null
}

function getEndDateColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  if (level === 'patient') return null
  return has(levelRelation(level, mapping), 'end_datetime') ? 'end_datetime' : null
}

/**
 * Build a link condition for a subquery from baseTable to targetTable.
 * Handles all combinations: patient→visit, patient→visit_detail, visit→visit_detail, visit_detail→visit.
 */
function buildSubqueryLink(
  cohortLevel: CohortLevel,
  targetLevel: 'visit' | 'visit_detail',
  baseTable: string,
  targetTable: string,
): string | null {
  if (cohortLevel === 'patient') return `${targetTable}.patient_id = ${baseTable}.patient_id`
  if (cohortLevel === 'visit' && targetLevel === 'visit_detail') return `${targetTable}.visit_id = ${baseTable}.visit_id`
  if (cohortLevel === 'visit_detail' && targetLevel === 'visit') return `${targetTable}.visit_id = ${baseTable}.visit_id`
  return null
}

/**
 * Build SELECT columns for result rows based on level.
 */
function buildSelectColumns(level: CohortLevel, mapping: SchemaMapping, baseTable: string): string {
  const cols: string[] = [`${baseTable}.${getIdColumn(level, mapping)} AS id`]
  const patient = classRelation(mapping, 'patient')
  const gv = mapping.patient?.genderValues
  const ref = level === 'patient' ? baseTable : 'p'

  // Patient ID (for visit/visit_detail levels)
  if (level !== 'patient') cols.push(`${baseTable}.patient_id AS patient_id`)

  // Gender — use CASE WHEN to show human-readable labels from genderValues mapping
  if (has(patient, 'gender_source_value')) {
    const src = `${ref}.gender_source_value`
    if (gv) {
      const cases: string[] = []
      cases.push(`WHEN ${src} = '${escSql(gv.male)}' THEN 'Male'`)
      cases.push(`WHEN ${src} = '${escSql(gv.female)}' THEN 'Female'`)
      if (gv.unknown) cases.push(`WHEN ${src} = '${escSql(gv.unknown)}' THEN 'Unknown'`)
      cols.push(`CASE ${cases.join(' ')} ELSE CAST(${src} AS TEXT) END AS gender`)
    } else {
      cols.push(`${src} AS gender`)
    }
  }

  // Age at admission (not current age) — use visit start date when available.
  // `birth_year` already falls back from the birth date to the year per row:
  // MIMIC-IV's person.birth_datetime is NULL for all 364k patients.
  if (patient && has(patient, 'birth_year')) {
    let dateRef: string
    let ageLabel: string

    if (level === 'patient') {
      // Patient level: use earliest visit start date
      const visit = classRelation(mapping, 'visit')
      if (visit) {
        dateRef = `(SELECT MIN(start_datetime) FROM ${visit.name} WHERE ${visit.name}.patient_id = ${baseTable}.patient_id)`
        ageLabel = 'age_at_admission'
      } else {
        dateRef = 'CURRENT_DATE'
        ageLabel = 'age_current'
      }
    } else {
      const startDateCol = getStartDateColumn(level, mapping)
      if (startDateCol) {
        dateRef = `${baseTable}.${startDateCol}`
        ageLabel = 'age_at_admission'
      } else {
        dateRef = 'CURRENT_DATE'
        ageLabel = 'age_current'
      }
    }
    cols.push(`DATE_PART('year', ${dateRef}::TIMESTAMP) - ${ref}.birth_year AS ${ageLabel}`)
  }

  // Start/end dates (for visit/visit_detail)
  const startCol = getStartDateColumn(level, mapping)
  const endCol = getEndDateColumn(level, mapping)
  if (startCol) cols.push(`${baseTable}.${startCol} AS start_date`)
  if (endCol) cols.push(`${baseTable}.${endCol} AS end_date`)

  return cols.join(',\n  ')
}

/** Human-readable label for a criteria tree node (for attrition chart). */
export function getNodeLabel(node: CriteriaTreeNode, mapping?: SchemaMapping): string {
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
      // The stored values are gender concept ids, and which id means what is a
      // property of the mapping (8532 is OMOP's female, another CDM's is not).
      // The picker named them when they were chosen, so an attrition step must
      // not read back "Sex: 8532".
      const gv = mapping?.patient?.genderValues
      const name = (v: string) =>
        v === gv?.male ? 'Male' : v === gv?.female ? 'Female' : v === gv?.unknown ? 'Unknown' : v
      return `${prefix}Sex: ${c.values.map(name).join(', ')}`
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
