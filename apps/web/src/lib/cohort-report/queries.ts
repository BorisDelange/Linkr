/**
 * The SQL behind a cohort report. Every query reads the cohort through its
 * membership (`buildCohortMembershipSql`: `id` at the cohort's level and
 * `patient_id`), so the figures describe exactly the rows the cohort selects,
 * and none of them is written by hand per data model: column names come from
 * the schema mapping, as the cohort builder's own SQL does.
 */
import type { CohortLevel, ConceptCriteriaConfig, SchemaMapping } from '@/types'
import { classRelation, eventRelation, eventRelations, has } from '@/lib/schema-classes/relations'

/** `SELECT … FROM (membership) m`, the shape every query below starts from. */
function members(membershipSql: string): string {
  return `(\n${membershipSql}\n) m`
}

/** Distinct patients and distinct ids at the cohort's level. */
export function buildCountsSql(membershipSql: string): string {
  return [
    'SELECT',
    '  COUNT(DISTINCT m.patient_id) AS patients,',
    '  COUNT(DISTINCT m.id) AS units',
    `FROM ${members(membershipSql)}`,
  ].join('\n')
}

/**
 * Hospital stays behind the cohort: every stay of its patients at patient level,
 * the parent stays of its unit stays at visit-detail level. At visit level the
 * units ARE the stays, so there is nothing to ask. Null when the mapping has no
 * table to count them in.
 */
export function buildVisitCountSql(
  membershipSql: string,
  level: CohortLevel,
  mapping: SchemaMapping,
): string | null {
  const visit = classRelation(mapping, 'visit')
  if (level === 'patient' && visit) {
    return [
      'SELECT COUNT(*) AS visits',
      `FROM ${visit.name} v`,
      `WHERE v.patient_id IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
    ].join('\n')
  }
  const vd = classRelation(mapping, 'visit_detail')
  if (level === 'visit_detail' && vd) {
    return [
      'SELECT COUNT(DISTINCT vd.visit_id) AS visits',
      `FROM ${vd.name} vd`,
      `WHERE vd.visit_detail_id IN (SELECT m.id FROM ${members(membershipSql)})`,
    ].join('\n')
  }
  return null
}

/**
 * `(id, patient_id, index_date)` per member: the date the cohort's unit starts —
 * the unit stay, the hospital stay, or a patient's first stay. What the age, the
 * month and the year of each member are measured from.
 */
export function buildIndexSql(
  membershipSql: string,
  level: CohortLevel,
  mapping: SchemaMapping,
): string | null {
  const vd = classRelation(mapping, 'visit_detail')
  if (level === 'visit_detail' && vd) {
    return [
      'SELECT m.id, m.patient_id, vd.start_datetime AS index_date',
      `FROM ${members(membershipSql)}`,
      `JOIN ${vd.name} vd ON vd.visit_detail_id = m.id`,
    ].join('\n')
  }
  const visit = classRelation(mapping, 'visit')
  if (level === 'visit' && visit) {
    return [
      'SELECT m.id, m.patient_id, v.start_datetime AS index_date',
      `FROM ${members(membershipSql)}`,
      `JOIN ${visit.name} v ON v.visit_id = m.id`,
    ].join('\n')
  }
  if (level === 'patient' && visit) {
    return [
      'SELECT m.id, m.patient_id, MIN(v.start_datetime) AS index_date',
      `FROM ${members(membershipSql)}`,
      `LEFT JOIN ${visit.name} v ON v.patient_id = m.patient_id`,
      'GROUP BY m.id, m.patient_id',
    ].join('\n')
  }
  return null
}

/** Members per 10-year age band at their index date, `bin` = the band's lower bound. */
export function buildAgeSql(indexSql: string, mapping: SchemaMapping): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!patient || !has(patient, 'birth_year')) return null
  const fromYear = '(EXTRACT(YEAR FROM CAST(i.index_date AS TIMESTAMP)) - p.birth_year)'
  // OMOP maps both, and many databases fill only the year (MIMIC-IV leaves
  // birth_datetime empty): the exact date when present, the year otherwise.
  const age = has(patient, 'birth_date')
    ? `COALESCE(EXTRACT(YEAR FROM age(CAST(i.index_date AS TIMESTAMP), CAST(p.birth_date AS TIMESTAMP))), ${fromYear})`
    : fromYear
  return [
    'SELECT CAST(FLOOR(a.age / 10) * 10 AS INTEGER) AS bin, COUNT(*) AS n',
    'FROM (',
    `  SELECT ${age} AS age`,
    `  FROM (\n${indexSql}\n) i`,
    `  JOIN ${patient.name} p ON p.patient_id = i.patient_id`,
    '  WHERE i.index_date IS NOT NULL',
    ') a',
    'WHERE a.age IS NOT NULL AND a.age >= 0',
    'GROUP BY 1',
    'ORDER BY 1',
  ].join('\n')
}

/** Patients per raw gender value; the report names them through `genderValues`. */
export function buildSexSql(membershipSql: string, mapping: SchemaMapping): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!has(patient, 'gender_source_value')) return null
  return [
    'SELECT CAST(p.gender_source_value AS VARCHAR) AS gender, COUNT(*) AS n',
    `FROM ${patient!.name} p`,
    `WHERE p.patient_id IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
    'GROUP BY 1',
    'ORDER BY 2 DESC',
  ].join('\n')
}

/** Members per month of their index date (`YYYY-MM`). */
export function buildMonthSql(indexSql: string): string {
  return [
    "SELECT strftime(CAST(i.index_date AS TIMESTAMP), '%Y-%m') AS month, COUNT(*) AS n",
    `FROM (\n${indexSql}\n) i`,
    'WHERE i.index_date IS NOT NULL',
    'GROUP BY 1',
    'ORDER BY 1',
  ].join('\n')
}

/** Every patient of the database, cohort or not. */
export function buildDatabasePatientsSql(mapping: SchemaMapping): string | null {
  const patient = classRelation(mapping, 'patient')
  return patient ? `SELECT COUNT(*) AS n FROM ${patient.name}` : null
}

/**
 * Rows and patients per event table, over the cohort's patients: what data the
 * cohort actually has. One UNION ALL, so the database is asked once.
 */
export function buildEventTablesSql(membershipSql: string, mapping: SchemaMapping): string | null {
  const parts = eventRelations(mapping)
    .filter((e) => has(e, 'patient_id'))
    .map((e) => [
      `SELECT '${(e.key ?? '').replace(/'/g, "''")}' AS label, COUNT(*) AS rows, COUNT(DISTINCT e.patient_id) AS patients`,
      `FROM ${e.name} e`,
      `WHERE e.patient_id IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
    ].join('\n'))
  return parts.length ? parts.join('\nUNION ALL\n') : null
}

/**
 * For one concept criterion: rows and patients per concept among the cohort's
 * patients. A row matching on its source concept counts under that id, as the
 * cohort's own criterion matches either column.
 */
export function buildConceptSql(
  membershipSql: string,
  mapping: SchemaMapping,
  config: ConceptCriteriaConfig,
): string | null {
  const event = eventRelation(mapping, config.eventTableLabel)
  const ids = config.conceptIds.filter((n) => Number.isFinite(n))
  if (!event || !has(event, 'patient_id') || ids.length === 0) return null
  const list = ids.join(', ')
  const withSource = has(event, 'source_concept_id')
  const concept = withSource
    ? `CASE WHEN e.concept_id IN (${list}) THEN e.concept_id ELSE e.source_concept_id END`
    : 'e.concept_id'
  const match = withSource
    ? `(e.concept_id IN (${list}) OR e.source_concept_id IN (${list}))`
    : `e.concept_id IN (${list})`
  return [
    `SELECT ${concept} AS concept_id, COUNT(*) AS rows, COUNT(DISTINCT e.patient_id) AS patients`,
    `FROM ${event.name} e`,
    `WHERE ${match}`,
    `  AND e.patient_id IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
    'GROUP BY 1',
  ].join('\n')
}

/**
 * Unit stays per care unit, over the cohort's unit stays — or, above that level,
 * the unit stays of its stays or patients. A stay through several units counts in
 * each. Null when the mapping names no unit.
 */
export function buildCareUnitSql(
  membershipSql: string,
  level: CohortLevel,
  mapping: SchemaMapping,
): string | null {
  const vd = classRelation(mapping, 'visit_detail')
  if (!vd || !has(vd, 'unit_name')) return null
  const scope =
    level === 'visit_detail' ? `vd.visit_detail_id IN (SELECT m.id FROM ${members(membershipSql)})`
      : level === 'visit' ? `vd.visit_id IN (SELECT m.id FROM ${members(membershipSql)})`
        : `vd.patient_id IN (SELECT m.patient_id FROM ${members(membershipSql)})`
  return [
    'SELECT vd.unit_name AS unit, COUNT(DISTINCT vd.visit_detail_id) AS n',
    `FROM ${vd.name} vd`,
    `WHERE ${scope}`,
    'GROUP BY 1',
    'ORDER BY 2 DESC',
  ].join('\n')
}
