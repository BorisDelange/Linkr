/**
 * The SQL behind a cohort report. Every query reads the cohort through its
 * membership (`buildCohortMembershipSql`: `id` at the cohort's level and
 * `patient_id`), so the figures describe exactly the rows the cohort selects,
 * and none of them is written by hand per data model: column names come from
 * the schema mapping, as the cohort builder's own SQL does.
 */
import { qualify } from '@/lib/schema-helpers'
import type { CohortLevel, ConceptCriteriaConfig, EventTable, SchemaMapping } from '@/types'

const col = (alias: string, column: string) => `${alias}."${column}"`

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
  if (level === 'patient' && mapping.visitTable) {
    const vt = mapping.visitTable
    return [
      'SELECT COUNT(*) AS visits',
      `FROM ${qualify(vt)} v`,
      `WHERE ${col('v', vt.patientIdColumn)} IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
    ].join('\n')
  }
  if (level === 'visit_detail' && mapping.visitDetailTable) {
    const vd = mapping.visitDetailTable
    return [
      `SELECT COUNT(DISTINCT ${col('vd', vd.visitIdColumn)}) AS visits`,
      `FROM ${qualify(vd)} vd`,
      `WHERE ${col('vd', vd.idColumn)} IN (SELECT m.id FROM ${members(membershipSql)})`,
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
  if (level === 'visit_detail' && mapping.visitDetailTable) {
    const vd = mapping.visitDetailTable
    return [
      `SELECT m.id, m.patient_id, ${col('vd', vd.startDateColumn)} AS index_date`,
      `FROM ${members(membershipSql)}`,
      `JOIN ${qualify(vd)} vd ON ${col('vd', vd.idColumn)} = m.id`,
    ].join('\n')
  }
  if (level === 'visit' && mapping.visitTable) {
    const vt = mapping.visitTable
    return [
      `SELECT m.id, m.patient_id, ${col('v', vt.startDateColumn)} AS index_date`,
      `FROM ${members(membershipSql)}`,
      `JOIN ${qualify(vt)} v ON ${col('v', vt.idColumn)} = m.id`,
    ].join('\n')
  }
  if (level === 'patient' && mapping.visitTable) {
    const vt = mapping.visitTable
    return [
      `SELECT m.id, m.patient_id, MIN(${col('v', vt.startDateColumn)}) AS index_date`,
      `FROM ${members(membershipSql)}`,
      `LEFT JOIN ${qualify(vt)} v ON ${col('v', vt.patientIdColumn)} = m.patient_id`,
      'GROUP BY m.id, m.patient_id',
    ].join('\n')
  }
  return null
}

/** Members per 10-year age band at their index date, `bin` = the band's lower bound. */
export function buildAgeSql(indexSql: string, mapping: SchemaMapping): string | null {
  const pt = mapping.patientTable
  if (!pt || (!pt.birthDateColumn && !pt.birthYearColumn)) return null
  const fromDate = pt.birthDateColumn
    ? `EXTRACT(YEAR FROM age(CAST(i.index_date AS TIMESTAMP), CAST(${col('p', pt.birthDateColumn)} AS TIMESTAMP)))`
    : null
  const fromYear = pt.birthYearColumn
    ? `(EXTRACT(YEAR FROM CAST(i.index_date AS TIMESTAMP)) - ${col('p', pt.birthYearColumn)})`
    : null
  // OMOP maps both, and many databases fill only the year (MIMIC-IV leaves
  // birth_datetime empty): the exact date when present, the year otherwise.
  const age = fromDate && fromYear ? `COALESCE(${fromDate}, ${fromYear})` : (fromDate ?? fromYear)
  return [
    'SELECT CAST(FLOOR(a.age / 10) * 10 AS INTEGER) AS bin, COUNT(*) AS n',
    'FROM (',
    `  SELECT ${age} AS age`,
    `  FROM (\n${indexSql}\n) i`,
    `  JOIN ${qualify(pt)} p ON ${col('p', pt.idColumn)} = i.patient_id`,
    '  WHERE i.index_date IS NOT NULL',
    ') a',
    'WHERE a.age IS NOT NULL AND a.age >= 0',
    'GROUP BY 1',
    'ORDER BY 1',
  ].join('\n')
}

/** Patients per raw gender value; the report names them through `genderValues`. */
export function buildSexSql(membershipSql: string, mapping: SchemaMapping): string | null {
  const pt = mapping.patientTable
  if (!pt?.genderColumn) return null
  return [
    `SELECT CAST(${col('p', pt.genderColumn)} AS VARCHAR) AS gender, COUNT(*) AS n`,
    `FROM ${qualify(pt)} p`,
    `WHERE ${col('p', pt.idColumn)} IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
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
  const pt = mapping.patientTable
  if (!pt) return null
  return `SELECT COUNT(*) AS n FROM ${qualify(pt)}`
}

function eventPatientColumn(et: EventTable, mapping: SchemaMapping): string | undefined {
  return et.patientIdColumn ?? mapping.patientTable?.idColumn
}

/**
 * Rows and patients per event table, over the cohort's patients: what data the
 * cohort actually has. One UNION ALL, so the database is asked once.
 */
export function buildEventTablesSql(membershipSql: string, mapping: SchemaMapping): string | null {
  const parts = Object.entries(mapping.eventTables ?? {}).flatMap(([label, et]) => {
    const pid = eventPatientColumn(et, mapping)
    if (!pid) return []
    return [[
      `SELECT '${label.replace(/'/g, "''")}' AS label, COUNT(*) AS rows, COUNT(DISTINCT ${col('e', pid)}) AS patients`,
      `FROM ${qualify(et)} e`,
      `WHERE ${col('e', pid)} IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
    ].join('\n')]
  })
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
  const et = mapping.eventTables?.[config.eventTableLabel]
  const pid = et ? eventPatientColumn(et, mapping) : undefined
  const ids = config.conceptIds.filter((n) => Number.isFinite(n))
  if (!et || !pid || ids.length === 0) return null
  const list = ids.join(', ')
  const concept = et.sourceConceptIdColumn
    ? `CASE WHEN ${col('e', et.conceptIdColumn)} IN (${list}) THEN ${col('e', et.conceptIdColumn)} ELSE ${col('e', et.sourceConceptIdColumn)} END`
    : col('e', et.conceptIdColumn)
  const match = et.sourceConceptIdColumn
    ? `(${col('e', et.conceptIdColumn)} IN (${list}) OR ${col('e', et.sourceConceptIdColumn)} IN (${list}))`
    : `${col('e', et.conceptIdColumn)} IN (${list})`
  return [
    `SELECT ${concept} AS concept_id, COUNT(*) AS rows, COUNT(DISTINCT ${col('e', pid)}) AS patients`,
    `FROM ${qualify(et)} e`,
    `WHERE ${match}`,
    `  AND ${col('e', pid)} IN (SELECT m.patient_id FROM ${members(membershipSql)})`,
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
  const vd = mapping.visitDetailTable
  const unit = vd?.unitSourceValueColumn ?? vd?.unitColumn
  if (!vd || !unit) return null
  const scope =
    level === 'visit_detail' ? `${col('vd', vd.idColumn)} IN (SELECT m.id FROM ${members(membershipSql)})`
      : level === 'visit' ? `${col('vd', vd.visitIdColumn)} IN (SELECT m.id FROM ${members(membershipSql)})`
        : `${col('vd', vd.patientIdColumn)} IN (SELECT m.patient_id FROM ${members(membershipSql)})`
  return [
    `SELECT CAST(${col('vd', unit)} AS VARCHAR) AS unit, COUNT(DISTINCT ${col('vd', vd.idColumn)}) AS n`,
    `FROM ${qualify(vd)} vd`,
    `WHERE ${scope}`,
    'GROUP BY 1',
    'ORDER BY 2 DESC',
  ].join('\n')
}
