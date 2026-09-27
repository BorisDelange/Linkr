import type { Cohort } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import { buildCohortQueryParts, escapeLikeTerm, escPatternLiteral } from './cohort-query'
import { classRelation, conceptJoinOn, dictionaryOf, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { escSql, validateIntegerIds } from '@/lib/format-helpers'

// ---------------------------------------------------------------------------
// Patient filters
// ---------------------------------------------------------------------------

export interface PatientFilters {
  gender?: string | null       // gender value to match (e.g. '8507', 'M')
  ageMin?: number | null       // minimum age (inclusive)
  ageMax?: number | null       // maximum age (inclusive)
  admissionAfter?: string | null  // admission date >= (ISO date string)
  admissionBefore?: string | null // admission date <= (ISO date string)
  deathStatus?: 'alive' | 'deceased' | null // vital status filter
  patientIdSearch?: string | null // substring match on the patient id
}

// ---------------------------------------------------------------------------
// Patient list
// ---------------------------------------------------------------------------

/**
 * Build query to list patients — optionally filtered by a cohort and patient filters.
 * Returns: patient_id, gender, age (relative to first visit), visit_count.
 */
export function buildPatientListQuery(
  mapping: SchemaMapping,
  cohort: Cohort | null,
  limit: number,
  offset: number,
  filters?: PatientFilters,
): string | null {
  const inner = buildPatientBaseQuery(mapping, cohort)
  if (!inner) return null

  const filterWhere = buildPatientFilterWhere(filters)
  return `WITH _patients AS (${inner})
SELECT * FROM _patients${filterWhere}
ORDER BY patient_id
LIMIT ${limit} OFFSET ${offset}`
}

/**
 * Count patients — optionally filtered by a cohort and patient filters.
 */
export function buildPatientCountQuery(
  mapping: SchemaMapping,
  cohort: Cohort | null,
  filters?: PatientFilters,
): string | null {
  const inner = buildPatientBaseQuery(mapping, cohort)
  if (!inner) return null

  const filterWhere = buildPatientFilterWhere(filters)
  return `WITH _patients AS (${inner})
SELECT COUNT(*) AS cnt FROM _patients${filterWhere}`
}

// ---------------------------------------------------------------------------
// Visit list for a patient
// ---------------------------------------------------------------------------

/**
 * Build query to list visits for a given patient.
 * Returns: visit_id, start_date, end_date.
 */
export function buildVisitListQuery(
  mapping: SchemaMapping,
  patientId: string,
): string | null {
  const visit = classRelation(mapping, 'visit')
  if (!visit) return null

  const endCol = has(visit, 'end_datetime') ? ', end_datetime AS end_date' : ''
  const typeCol = has(visit, 'visit_type') ? ', visit_type' : ''

  return `SELECT visit_id,
  start_datetime AS start_date${endCol}${typeCol}
FROM ${visit.name}
WHERE patient_id = '${escSql(patientId)}'
ORDER BY start_datetime`
}

// ---------------------------------------------------------------------------
// Visit details (stays within a hospitalization)
// ---------------------------------------------------------------------------

/**
 * Build query to list visit details (sub-stays) for a given visit.
 * Returns: visit_detail_id, start_date, end_date, unit.
 */
export function buildVisitDetailListQuery(
  mapping: SchemaMapping,
  visitId: string,
): string | null {
  const vd = classRelation(mapping, 'visit_detail')
  if (!vd) return null

  const endCol = has(vd, 'end_datetime') ? ', end_datetime AS end_date' : ''
  const unitCol = has(vd, 'unit_name') ? ', unit_name AS unit' : ''

  return `SELECT visit_detail_id,
  start_datetime AS start_date${endCol}${unitCol}
FROM ${vd.name}
WHERE visit_id = '${escSql(visitId)}'
ORDER BY start_datetime`
}

// ---------------------------------------------------------------------------
// Patient demographics
// ---------------------------------------------------------------------------

/**
 * Build query for a single patient's demographics.
 * Age is computed relative to the selected visit start date (or first visit if no visitId).
 */
export function buildPatientDemographicsQuery(
  mapping: SchemaMapping,
  patientId: string,
  visitId: string | null = null,
): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!patient) return null
  const visit = classRelation(mapping, 'visit')

  const genderCol = has(patient, 'gender_source_value') ? ', p.gender_source_value AS gender' : ''
  const deathCol = has(patient, 'death_datetime') ? ', p.death_datetime AS death_date' : ''

  if (visit) {
    // Age relative to selected visit start date, or first visit if none selected
    const refDate = visitId
      ? `(SELECT start_datetime FROM ${visit.name} WHERE visit_id = '${escSql(visitId)}')`
      : 'MIN(v.start_datetime)'
    const ageCol = ageColumn(patient, 'p', refDate, 'age')

    return `SELECT p.patient_id${genderCol}${ageCol}${deathCol},
  COUNT(v.visit_id) AS visit_count
FROM ${patient.name} p
LEFT JOIN ${visit.name} v ON p.patient_id = v.patient_id
WHERE p.patient_id = '${escSql(patientId)}'
GROUP BY ${PATIENT_GROUP_BY('p')}`
  }

  return `SELECT p.patient_id${genderCol}${ageColumn(patient, 'p', 'CURRENT_DATE', 'age')}${deathCol}
FROM ${patient.name} p
WHERE p.patient_id = '${escSql(patientId)}'`
}

// ---------------------------------------------------------------------------
// Patient summary (extended demographics for summary widget)
// ---------------------------------------------------------------------------

/**
 * Build query for the patient summary widget.
 * Returns: patient_id, gender, death_date, first_visit_start, last_visit_start,
 *          age_first_visit, age_last_visit, visit_count, visit_detail_count.
 */
export function buildPatientSummaryQuery(
  mapping: SchemaMapping,
  patientId: string,
): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!patient) return null
  const visit = classRelation(mapping, 'visit')

  const genderCol = has(patient, 'gender_source_value') ? ', p.gender_source_value AS gender' : ''
  const deathCol = has(patient, 'death_datetime') ? ', p.death_datetime AS death_date' : ''

  if (visit) {
    const ageFirstCol = ageColumn(patient, 'p', 'MIN(v.start_datetime)', 'age_first_visit')
    const ageLastCol = ageColumn(patient, 'p', 'MAX(v.start_datetime)', 'age_last_visit')

    // Visit detail count (sub-query to avoid messing up the GROUP BY)
    const vd = classRelation(mapping, 'visit_detail')
    const vdCountCol = vd
      ? `, (SELECT COUNT(*) FROM ${vd.name} WHERE patient_id = '${escSql(patientId)}') AS visit_detail_count`
      : ''

    // Total hospitalization length of stay (sum of per-visit LOS in days).
    const totalLosCol = has(visit, 'end_datetime')
      ? `, SUM(DATE_DIFF('day', v.start_datetime::DATE, v.end_datetime::DATE)) AS total_los_days`
      : ''

    return `SELECT p.patient_id${genderCol}${deathCol},
  MIN(v.start_datetime) AS first_visit_start,
  MAX(v.start_datetime) AS last_visit_start${ageFirstCol}${ageLastCol},
  COUNT(DISTINCT v.visit_id) AS visit_count${vdCountCol}${totalLosCol}
FROM ${patient.name} p
LEFT JOIN ${visit.name} v ON p.patient_id = v.patient_id
WHERE p.patient_id = '${escSql(patientId)}'
GROUP BY ${PATIENT_GROUP_BY('p')}`
  }

  // No visit table — simpler query
  return `SELECT p.patient_id${genderCol}${deathCol}${ageColumn(patient, 'p', 'CURRENT_DATE', 'age_first_visit')}
FROM ${patient.name} p
WHERE p.patient_id = '${escSql(patientId)}'`
}

/**
 * Build query for the visit+stay summary list.
 * Returns rows of type 'visit' or 'visit_detail' sorted by date.
 * Columns: row_type, visit_id, visit_detail_id, start_date, end_date, visit_type, unit, los_days.
 */
export function buildPatientVisitSummaryQuery(
  mapping: SchemaMapping,
  patientId: string,
): string | null {
  const visit = classRelation(mapping, 'visit')
  if (!visit) return null

  const parts: string[] = [`SELECT 'visit' AS row_type,
  visit_id,
  NULL AS visit_detail_id,
  start_datetime AS start_date, ${endAndLos(visit, 'visit_type', 'NULL')}
FROM ${visit.name}
WHERE patient_id = '${escSql(patientId)}'`]

  const vd = classRelation(mapping, 'visit_detail')
  if (vd) {
    parts.push(`SELECT 'visit_detail' AS row_type,
  visit_id,
  visit_detail_id,
  start_datetime AS start_date, ${endAndLos(vd, 'NULL', 'unit_name')}
FROM ${vd.name}
WHERE patient_id = '${escSql(patientId)}'`)
  }

  return `${parts.join('\nUNION ALL\n')}
ORDER BY start_date, row_type`
}

/** `end_date, visit_type, unit, los_days` for one branch of the visit summary. */
function endAndLos(rel: ClassRelation, visitType: string, unit: string): string {
  const hasEnd = has(rel, 'end_datetime')
  const col = (c: string) => (c === 'NULL' || has(rel, c) ? c : 'NULL')
  return [
    `${hasEnd ? 'end_datetime' : 'NULL'} AS end_date`,
    `${col(visitType)} AS visit_type`,
    `${col(unit)} AS unit`,
    `${hasEnd ? "DATE_DIFF('day', start_datetime::DATE, end_datetime::DATE)" : 'NULL'} AS los_days`,
  ].join(',\n  ')
}

// ---------------------------------------------------------------------------
// Timeline data (numeric measurements over time)
// ---------------------------------------------------------------------------

/**
 * Build query for timeline data — selected concepts over time.
 * Queries ALL event tables that have a value column and date column.
 * Returns: concept_id, concept_name, value, value_string, event_date, end_date.
 *
 * `value_string` and `end_date` are what let the timeline draw more than curves:
 * a categorical observation has no number to plot, and an event with an end date
 * is a span rather than a reading. Both are NULL for a table that maps neither,
 * so every branch of the UNION stays column-compatible.
 */
export function buildTimelineQuery(
  mapping: SchemaMapping,
  conceptIds: number[],
  patientId: string,
  visitId: string | null,
): string | null {
  if (conceptIds.length === 0) return null
  if (!validateIntegerIds(conceptIds)) return null
  const idList = conceptIds.join(', ')
  const parts: string[] = []

  for (const event of eventRelations(mapping)) {
    if (!has(event, 'patient_id') || !has(event, 'start_datetime')) continue
    // A table with neither kind of value has nothing to put on a timeline.
    if (!has(event, 'value_number') && !has(event, 'value_string')) continue

    // A table that names its concept inline holds "Vancomycin", not an id.
    // Matching it against numeric ids cannot select anything, and DuckDB casts
    // the whole column to compare, failing on the first non-numeric row. Every
    // branch shares one UNION ALL, so that single error empties the widget.
    if (event.dictionary === null) continue

    const dict = dictionaryOf(mapping, event)
    const conceptMatch = has(event, 'source_concept_id')
      ? `e.concept_id IN (${idList}) OR e.source_concept_id IN (${idList})`
      : `e.concept_id IN (${idList})`
    const visitFilter = visitId && classRelation(mapping, 'visit') ? `\n  AND e.visit_id = '${escSql(visitId)}'` : ''

    // Unit and route, resolved the way the overview does it — a bare figure says
    // nothing without its unit, and the route is what tells a drip from a bolus
    // where the standard vocabulary calls both "Intravenous". Source text is
    // preferred over the standard concept: "mmHg" reads better than "millimeter
    // mercury column", and it keeps distinctions the vocabulary drops.
    const unitJoin = dict && has(event, 'unit_concept_id')
      ? `\nLEFT JOIN ${dict.name} uc ON uc.concept_id = e.unit_concept_id`
      : ''
    const routeJoin = dict && has(event, 'route_concept_id')
      ? `\nLEFT JOIN ${dict.name} rc ON rc.concept_id = e.route_concept_id`
      : ''
    const unitExpr = labelled(has(event, 'unit') ? 'e.unit' : null, unitJoin ? 'uc.concept_name' : null)
    const routeExpr = labelled(has(event, 'route') ? 'e.route' : null, routeJoin ? 'rc.concept_name' : null)

    // Keep a row when EITHER value is present: dropping on the numeric column
    // alone would discard every categorical event the string column carries.
    const presence = (['value_number', 'value_string'] as const)
      .filter((c) => has(event, c))
      .map((c) => `e.${c} IS NOT NULL`)
      .join(' OR ')

    const nameExpr = dict ? 'c.concept_name' : 'CAST(e.concept_id AS VARCHAR)'
    const join = dict ? `\nINNER JOIN ${dict.name} c ON ${conceptJoinOn(event, 'e', 'c')}` : ''

    parts.push(`SELECT e.concept_id,
  ${nameExpr} AS concept_name,
  e.value_number AS value,
  e.value_string,
  ${unitExpr} AS unit,
  ${routeExpr} AS route,
  ${has(event, 'rate_value') ? 'e.rate_value' : 'NULL'} AS rate_value,
  ${has(event, 'rate_unit') ? 'CAST(e.rate_unit AS VARCHAR)' : 'NULL'} AS rate_unit,
  ${event.cls === 'drug' ? 'TRUE' : 'FALSE'} AS is_drug,
  e.start_datetime AS event_date,
  e.end_datetime AS end_date
FROM ${event.name} e${join}${unitJoin}${routeJoin}
WHERE e.patient_id = '${escSql(patientId)}'
  AND (${conceptMatch})
  AND (${presence})${visitFilter}`)
  }

  if (parts.length === 0) return null
  return `${parts.join('\nUNION ALL\n')}\nORDER BY event_date`
}

/** Source text first, the standard concept's name as the fallback. */
function labelled(source: string | null, standard: string | null): string {
  if (source && standard) return `COALESCE(${source}, ${standard})`
  return source ?? standard ?? 'NULL'
}

// ---------------------------------------------------------------------------
// Notes (clinical documents)
// ---------------------------------------------------------------------------

/**
 * Build query for clinical notes — finds the note table from schema mapping.
 * Returns: note_id, note_date, note_title, note_text, note_type, visit_id.
 */
export function buildNotesQuery(
  mapping: SchemaMapping,
  patientId: string,
  visitId: string | null,
): string | null {
  const note = classRelation(mapping, 'note')
  if (!note) return null

  const visitFilter = visitId && has(note, 'visit_id') ? `\n  AND visit_id = '${escSql(visitId)}'` : ''
  const orEmpty = (c: string) => (has(note, c) ? c : "''")

  return `SELECT note_id,
  note_datetime AS note_date,
  ${orEmpty('title')} AS note_title,
  text AS note_text,
  ${orEmpty('note_type')} AS note_type,
  visit_id
FROM ${note.name}
WHERE patient_id = '${escSql(patientId)}'${visitFilter}
ORDER BY note_datetime DESC`
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/** Every patient column a per-patient aggregate selects must be grouped. */
const PATIENT_GROUP_BY = (alias: string) =>
  ['patient_id', 'gender_source_value', 'death_datetime', 'birth_year'].map((c) => `${alias}.${c}`).join(', ')

/** `, <age> AS <label>` relative to a reference date, or '' when no birth column is mapped. */
function ageColumn(patient: ClassRelation, alias: string, refDateExpr: string, label: string): string {
  if (!has(patient, 'birth_year')) return ''
  return `, DATE_PART('year', (${refDateExpr})::TIMESTAMP) - ${alias}.birth_year AS ${label}`
}

/**
 * Build base patient query (without LIMIT/OFFSET/ORDER or filter WHERE).
 * Returns columns: patient_id, gender?, age?, visit_count?, first_admission?.
 * Used by both buildPatientListQuery and buildPatientCountQuery.
 */
function buildPatientBaseQuery(
  mapping: SchemaMapping,
  cohort: Cohort | null,
): string | null {
  const patient = classRelation(mapping, 'patient')
  if (!patient) return null
  const visit = classRelation(mapping, 'visit')
  const vd = classRelation(mapping, 'visit_detail')

  const genderCol = (alias: string) => (has(patient, 'gender_source_value') ? `, ${alias}.gender_source_value AS gender` : '')
  // Optional stay count per patient via correlated subquery (no GROUP BY impact).
  const stayCount = (alias: string) =>
    vd ? `, (SELECT COUNT(*) FROM ${vd.name} _vd WHERE _vd.patient_id = ${alias}.patient_id) AS stay_count` : ''

  /** The per-patient columns over `from`, grouped when visits are joined as `v`. */
  const perPatient = (alias: string, from: string, where: string): string => {
    if (!visit) {
      return `SELECT ${alias}.patient_id${genderCol(alias)}${ageColumn(patient, alias, 'CURRENT_DATE', 'age')}, ${alias}.death_datetime AS death_date
FROM ${from}${where}`
    }
    return `SELECT ${alias}.patient_id${genderCol(alias)}${ageColumn(patient, alias, 'MIN(v.start_datetime)', 'age')},
  COUNT(DISTINCT v.visit_id) AS visit_count${stayCount(alias)}, ${alias}.death_datetime AS death_date,
  MIN(v.start_datetime) AS first_admission
FROM ${from}
LEFT JOIN ${visit.name} v ON ${alias}.patient_id = v.patient_id${where}
GROUP BY ${PATIENT_GROUP_BY(alias)}`
  }

  // Materialized cohort: read the frozen membership instead of recomputing the
  // criteria tree, so results stay stable even if the source data changed.
  const mat = cohort?.materialization
  if (mat) {
    // An empty snapshot is a valid (empty) cohort — force a no-match filter.
    // Ids are quoted+escaped; string comparison works for numeric id columns too.
    const inList = mat.patientIds.map((id) => `'${escSql(id)}'`).join(', ')
    return perPatient('p', `${patient.name} p`, inList ? `\nWHERE p.patient_id IN (${inList})` : '\nWHERE 1=0')
  }

  if (cohort && cohort.criteriaTree.children.length > 0) {
    const parts = buildCohortQueryParts(cohort, mapping)
    if (!parts) return null
    const where = parts.whereClause ? `\nWHERE ${parts.whereClause}` : ''
    if (cohort.level === 'patient') {
      return perPatient(parts.baseTable, parts.from, where)
    }
    // A stay-level cohort lists the patients owning a matching stay.
    const members = `SELECT DISTINCT ${parts.baseTable}.patient_id FROM ${parts.from}${where}`
    return perPatient('p', `${patient.name} p`, `\nWHERE p.patient_id IN (${members})`)
  }

  return perPatient('p', `${patient.name} p`, '')
}

/** Build WHERE clause for patient filters applied to the CTE. */
function buildPatientFilterWhere(filters?: PatientFilters): string {
  if (!filters) return ''
  const clauses: string[] = []

  if (filters.gender) {
    clauses.push(`gender = '${escSql(filters.gender)}'`)
  }
  if (filters.ageMin != null) {
    clauses.push(`age >= ${Number(filters.ageMin)}`)
  }
  if (filters.ageMax != null) {
    clauses.push(`age <= ${Number(filters.ageMax)}`)
  }
  if (filters.admissionAfter) {
    clauses.push(`first_admission >= '${escSql(filters.admissionAfter)}'`)
  }
  if (filters.admissionBefore) {
    clauses.push(`first_admission <= '${escSql(filters.admissionBefore)}'`)
  }
  if (filters.deathStatus === 'deceased') {
    clauses.push(`death_date IS NOT NULL`)
  } else if (filters.deathStatus === 'alive') {
    clauses.push(`death_date IS NULL`)
  }
  const idSearch = filters.patientIdSearch?.trim()
  if (idSearch) {
    // Cast: the id is an integer in OMOP but a string elsewhere, and the user
    // types a fragment of it. ILIKE on the cast text matches both. Quoted with
    // escPatternLiteral, not escSql — escSql would double the backslashes the
    // LIKE escaping just added and the ESCAPE clause would stop working.
    clauses.push(
      `CAST(patient_id AS VARCHAR) ILIKE '${escPatternLiteral(`%${escapeLikeTerm(idSearch)}%`)}' ESCAPE '\\'`,
    )
  }

  return clauses.length > 0
    ? `\nWHERE ${clauses.join(' AND ')}`
    : ''
}
