import type { Cohort } from '@/types'
import type { SchemaMapping, EventTable } from '@/types/schema-mapping'
import { buildCohortQueryParts } from './cohort-query'
import { getDictionaryForEvent, buildConceptJoinCondition } from '@/lib/schema-helpers'
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
  const vt = mapping.visitTable
  if (!vt) return null

  const endCol = vt.endDateColumn
    ? `, "${vt.endDateColumn}" AS end_date`
    : ''
  const typeCol = vt.typeColumn
    ? `, "${vt.typeColumn}" AS visit_type`
    : ''

  return `SELECT "${vt.idColumn}" AS visit_id,
  "${vt.startDateColumn}" AS start_date${endCol}${typeCol}
FROM "${vt.table}"
WHERE "${vt.patientIdColumn}" = '${escSql(patientId)}'
ORDER BY "${vt.startDateColumn}"`
}

// ---------------------------------------------------------------------------
// Visit details (stays within a hospitalization)
// ---------------------------------------------------------------------------

/**
 * Build query to list visit details (sub-stays) for a given visit.
 * Returns: visit_detail_id, start_date, end_date, unit.
 * When unitNameTable is configured, joins to resolve unit IDs to names.
 */
export function buildVisitDetailListQuery(
  mapping: SchemaMapping,
  visitId: string,
): string | null {
  const vdt = mapping.visitDetailTable
  if (!vdt) return null

  const endCol = vdt.endDateColumn
    ? `, vd."${vdt.endDateColumn}" AS end_date`
    : ''

  // Resolve unit name via lookup table if configured, otherwise use raw column
  const hasUnitJoin = vdt.unitColumn && vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn
  const unitCol = hasUnitJoin
    ? `, un."${vdt.unitNameColumn}" AS unit`
    : vdt.unitColumn
      ? `, vd."${vdt.unitColumn}" AS unit`
      : ''
  const unitJoin = hasUnitJoin
    ? `\nLEFT JOIN "${vdt.unitNameTable}" un ON vd."${vdt.unitColumn}" = un."${vdt.unitNameIdColumn}"`
    : ''

  return `SELECT vd."${vdt.idColumn}" AS visit_detail_id,
  vd."${vdt.startDateColumn}" AS start_date${endCol}${unitCol}
FROM "${vdt.table}" vd${unitJoin}
WHERE vd."${vdt.visitIdColumn}" = '${escSql(visitId)}'
ORDER BY vd."${vdt.startDateColumn}"`
}

/**
 * Build query to get distinct units for a given visit (from visit_detail).
 * Returns: unit.
 */
export function buildVisitUnitsQuery(
  mapping: SchemaMapping,
  visitId: string,
): string | null {
  const vdt = mapping.visitDetailTable
  if (!vdt || !vdt.unitColumn) return null

  const hasUnitJoin = vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn
  if (hasUnitJoin) {
    return `SELECT DISTINCT un."${vdt.unitNameColumn}" AS unit
FROM "${vdt.table}" vd
LEFT JOIN "${vdt.unitNameTable}" un ON vd."${vdt.unitColumn}" = un."${vdt.unitNameIdColumn}"
WHERE vd."${vdt.visitIdColumn}" = '${escSql(visitId)}'
ORDER BY unit`
  }

  return `SELECT DISTINCT "${vdt.unitColumn}" AS unit
FROM "${vdt.table}"
WHERE "${vdt.visitIdColumn}" = '${escSql(visitId)}'
ORDER BY "${vdt.unitColumn}"`
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
  const pt = mapping.patientTable
  if (!pt) return null
  const vt = mapping.visitTable

  if (vt) {
    const genderCol = pt.genderColumn ? `, p."${pt.genderColumn}" AS gender` : ''
    // Age relative to selected visit start date, or first visit if none selected
    const refDate = visitId
      ? `(SELECT "${vt.startDateColumn}" FROM "${vt.table}" WHERE "${vt.idColumn}" = '${escSql(visitId)}')`
      : `MIN(v."${vt.startDateColumn}")`
    const ageExpr = buildAgeExprAlias('p', pt, refDate)
    const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''

    return `SELECT p."${pt.idColumn}" AS patient_id${genderCol}${ageCol},
  COUNT(v."${vt.idColumn}") AS visit_count
FROM "${pt.table}" p
LEFT JOIN "${vt.table}" v ON p."${pt.idColumn}" = v."${vt.patientIdColumn}"
WHERE p."${pt.idColumn}" = '${escSql(patientId)}'
GROUP BY p."${pt.idColumn}"${pt.genderColumn ? `, p."${pt.genderColumn}"` : ''}${buildBirthGroupBy('p', pt)}`
  }

  const genderCol = pt.genderColumn ? `, "${pt.genderColumn}" AS gender` : ''
  const ageExpr = buildAgeExpr(pt, 'CURRENT_DATE')
  const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''

  return `SELECT "${pt.idColumn}" AS patient_id${genderCol}${ageCol}
FROM "${pt.table}"
WHERE "${pt.idColumn}" = '${escSql(patientId)}'`
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
  const pt = mapping.patientTable
  if (!pt) return null
  const vt = mapping.visitTable

  const genderCol = pt.genderColumn ? `, p."${pt.genderColumn}" AS gender` : ''

  // Death date: prefer patientTable.deathDateColumn, fallback to deathTable
  let deathCol = ''
  let deathJoin = ''
  if (pt.deathDateColumn) {
    deathCol = `, p."${pt.deathDateColumn}" AS death_date`
  } else if (mapping.deathTable) {
    const dt = mapping.deathTable
    deathCol = `, d."${dt.dateColumn}" AS death_date`
    deathJoin = `\nLEFT JOIN "${dt.table}" d ON p."${pt.idColumn}" = d."${dt.patientIdColumn}"`
  }

  if (vt) {
    const ageFirstExpr = buildAgeExprAlias('p', pt, `MIN(v."${vt.startDateColumn}")`)
    const ageLastExpr = buildAgeExprAlias('p', pt, `MAX(v."${vt.startDateColumn}")`)
    const ageFirstCol = ageFirstExpr ? `, ${ageFirstExpr} AS age_first_visit` : ''
    const ageLastCol = ageLastExpr ? `, ${ageLastExpr} AS age_last_visit` : ''

    // Visit detail count (sub-query to avoid messing up the GROUP BY)
    const vdt = mapping.visitDetailTable
    let vdCountCol = ''
    if (vdt) {
      vdCountCol = `, (SELECT COUNT(*) FROM "${vdt.table}" WHERE "${vdt.patientIdColumn}" = '${escSql(patientId)}') AS visit_detail_count`
    }

    let deathGroupBy = ''
    if (pt.deathDateColumn) {
      deathGroupBy = `, p."${pt.deathDateColumn}"`
    } else if (mapping.deathTable) {
      deathGroupBy = `, d."${mapping.deathTable.dateColumn}"`
    }

    return `SELECT p."${pt.idColumn}" AS patient_id${genderCol}${deathCol},
  MIN(v."${vt.startDateColumn}") AS first_visit_start,
  MAX(v."${vt.startDateColumn}") AS last_visit_start${ageFirstCol}${ageLastCol},
  COUNT(DISTINCT v."${vt.idColumn}") AS visit_count${vdCountCol}
FROM "${pt.table}" p
LEFT JOIN "${vt.table}" v ON p."${pt.idColumn}" = v."${vt.patientIdColumn}"${deathJoin}
WHERE p."${pt.idColumn}" = '${escSql(patientId)}'
GROUP BY p."${pt.idColumn}"${pt.genderColumn ? `, p."${pt.genderColumn}"` : ''}${deathGroupBy}${buildBirthGroupBy('p', pt)}`
  }

  // No visit table — simpler query
  const ageExpr = buildAgeExprAlias('p', pt, 'CURRENT_DATE')
  const ageCol = ageExpr ? `, ${ageExpr} AS age_first_visit` : ''

  return `SELECT p."${pt.idColumn}" AS patient_id${genderCol}${deathCol}${ageCol}
FROM "${pt.table}" p${deathJoin}
WHERE p."${pt.idColumn}" = '${escSql(patientId)}'`
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
  const vt = mapping.visitTable
  if (!vt) return null

  const endCol = vt.endDateColumn
    ? `, "${vt.endDateColumn}" AS end_date`
    : ', NULL AS end_date'
  const typeCol = vt.typeColumn
    ? `, "${vt.typeColumn}" AS visit_type`
    : ", NULL AS visit_type"
  const losExpr = vt.endDateColumn
    ? `, DATE_DIFF('day', "${vt.startDateColumn}"::DATE, "${vt.endDateColumn}"::DATE) AS los_days`
    : ', NULL AS los_days'

  const parts: string[] = []

  parts.push(`SELECT 'visit' AS row_type,
  "${vt.idColumn}" AS visit_id,
  NULL AS visit_detail_id,
  "${vt.startDateColumn}" AS start_date${endCol}${typeCol},
  NULL AS unit${losExpr}
FROM "${vt.table}"
WHERE "${vt.patientIdColumn}" = '${escSql(patientId)}'`)

  const vdt = mapping.visitDetailTable
  if (vdt) {
    const vdEndCol = vdt.endDateColumn
      ? `, vd."${vdt.endDateColumn}" AS end_date`
      : ', NULL AS end_date'
    const vdLosExpr = vdt.endDateColumn
      ? `, DATE_DIFF('day', vd."${vdt.startDateColumn}"::DATE, vd."${vdt.endDateColumn}"::DATE) AS los_days`
      : ', NULL AS los_days'

    // Resolve unit name
    const hasUnitJoin = vdt.unitColumn && vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn
    const unitCol = hasUnitJoin
      ? `, un."${vdt.unitNameColumn}" AS unit`
      : vdt.unitColumn
        ? `, vd."${vdt.unitColumn}" AS unit`
        : ', NULL AS unit'
    const unitJoin = hasUnitJoin
      ? `\nLEFT JOIN "${vdt.unitNameTable}" un ON vd."${vdt.unitColumn}" = un."${vdt.unitNameIdColumn}"`
      : ''

    parts.push(`SELECT 'visit_detail' AS row_type,
  vd."${vdt.visitIdColumn}" AS visit_id,
  vd."${vdt.idColumn}" AS visit_detail_id,
  vd."${vdt.startDateColumn}" AS start_date${vdEndCol},
  NULL AS visit_type${unitCol}${vdLosExpr}
FROM "${vdt.table}" vd${unitJoin}
WHERE vd."${vdt.patientIdColumn}" = '${escSql(patientId)}'`)
  }

  return `${parts.join('\nUNION ALL\n')}
ORDER BY start_date, row_type`
}

// ---------------------------------------------------------------------------
// Timeline data (numeric measurements over time)
// ---------------------------------------------------------------------------

/**
 * Build query for timeline data — numeric values for selected concepts over time.
 * Queries ALL event tables that have a value column and date column.
 * Returns: concept_id, concept_name, value, event_date.
 */
export function buildTimelineQuery(
  mapping: SchemaMapping,
  conceptIds: number[],
  patientId: string,
  visitId: string | null,
): string | null {
  if (!mapping.eventTables || conceptIds.length === 0) return null
  if (!validateIntegerIds(conceptIds)) return null
  const idList = conceptIds.join(', ')
  const parts: string[] = []

  for (const [, et] of Object.entries(mapping.eventTables)) {
    if (!et.valueColumn || !et.dateColumn) continue
    const patientIdCol = et.patientIdColumn ?? mapping.patientTable?.idColumn
    if (!patientIdCol) continue

    const dict = getDictionaryForEvent(mapping, et)
    const conceptMatch = buildConceptInCondition('e', et, idList)
    const visitFilter = buildVisitFilter(mapping, visitId, 'e')

    if (dict) {
      const joinCond = buildConceptJoinCondition('e', 'c', et, dict)
      parts.push(`SELECT e."${et.conceptIdColumn}" AS concept_id,
  c."${dict.nameColumn}" AS concept_name,
  e."${et.valueColumn}" AS value,
  e."${et.dateColumn}" AS event_date
FROM "${et.table}" e
INNER JOIN "${dict.table}" c ON ${joinCond}
WHERE e."${patientIdCol}" = '${escSql(patientId)}'
  AND (${conceptMatch})
  AND e."${et.valueColumn}" IS NOT NULL${visitFilter}`)
    } else {
      parts.push(`SELECT e."${et.conceptIdColumn}" AS concept_id,
  CAST(e."${et.conceptIdColumn}" AS VARCHAR) AS concept_name,
  e."${et.valueColumn}" AS value,
  e."${et.dateColumn}" AS event_date
FROM "${et.table}" e
WHERE e."${patientIdCol}" = '${escSql(patientId)}'
  AND (${conceptMatch})
  AND e."${et.valueColumn}" IS NOT NULL${visitFilter}`)
    }
  }

  if (parts.length === 0) return null
  if (parts.length === 1) return `${parts[0]}\nORDER BY event_date`
  return `${parts.join('\nUNION ALL\n')}\nORDER BY event_date`
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
  const nt = mapping.noteTable
  if (!nt) return null

  const titleCol = nt.titleColumn
    ? `, "${nt.titleColumn}" AS note_title`
    : ", '' AS note_title"
  const typeCol = nt.typeColumn
    ? `, "${nt.typeColumn}" AS note_type`
    : ", '' AS note_type"
  const visitCol = nt.visitIdColumn
    ? `, "${nt.visitIdColumn}" AS visit_id`
    : ', NULL AS visit_id'
  const visitFilter = visitId && nt.visitIdColumn
    ? `\n  AND "${nt.visitIdColumn}" = '${escSql(visitId)}'`
    : ''

  return `SELECT "${nt.idColumn}" AS note_id,
  "${nt.dateColumn}" AS note_date${titleCol},
  "${nt.textColumn}" AS note_text${typeCol}${visitCol}
FROM "${nt.table}"
WHERE "${nt.patientIdColumn}" = '${escSql(patientId)}'${visitFilter}
ORDER BY "${nt.dateColumn}" DESC`
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Build base patient query (without LIMIT/OFFSET/ORDER or filter WHERE).
 * Returns columns: patient_id, gender?, age?, visit_count?, first_admission?.
 * Used by both buildPatientListQuery and buildPatientCountQuery.
 */
function buildPatientBaseQuery(
  mapping: SchemaMapping,
  cohort: Cohort | null,
): string | null {
  const pt = mapping.patientTable
  if (!pt) return null
  const vt = mapping.visitTable

  if (cohort && cohort.criteriaTree.children.length > 0) {
    const parts = buildCohortQueryParts(cohort, mapping)
    if (!parts) return null

    if (cohort.level === 'patient') {
      const genderCol = pt.genderColumn ? `, "${pt.table}"."${pt.genderColumn}" AS gender` : ''
      if (vt) {
        const ageExpr = buildAgeExpr(pt, `MIN(v_age."${vt.startDateColumn}")`)
        const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''
        return `SELECT "${pt.table}"."${pt.idColumn}" AS patient_id${genderCol}${ageCol},
  COUNT(DISTINCT v_age."${vt.idColumn}") AS visit_count,
  MIN(v_age."${vt.startDateColumn}") AS first_admission
FROM ${parts.from}
LEFT JOIN "${vt.table}" v_age ON "${pt.table}"."${pt.idColumn}" = v_age."${vt.patientIdColumn}"
${parts.whereClause}
GROUP BY "${pt.table}"."${pt.idColumn}"${pt.genderColumn ? `, "${pt.table}"."${pt.genderColumn}"` : ''}${buildBirthGroupBy(`"${pt.table}"`, pt)}`
      }
      const ageExpr = buildAgeExpr(pt, 'CURRENT_DATE')
      const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''
      return `SELECT DISTINCT "${pt.table}"."${pt.idColumn}" AS patient_id${genderCol}${ageCol}
FROM ${parts.from}
${parts.whereClause}`
    }

    // Visit-level cohort
    if (!vt) return null
    const genderCol = pt.genderColumn ? `, p2."${pt.genderColumn}" AS gender` : ''
    const ageExpr = buildAgeExprAlias('p2', pt, `MIN(v_age."${vt.startDateColumn}")`)
    const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''

    return `SELECT "${vt.table}"."${vt.patientIdColumn}" AS patient_id${genderCol}${ageCol},
  COUNT(DISTINCT v_age."${vt.idColumn}") AS visit_count,
  MIN(v_age."${vt.startDateColumn}") AS first_admission
FROM ${parts.from}
INNER JOIN "${pt.table}" p2 ON "${vt.table}"."${vt.patientIdColumn}" = p2."${pt.idColumn}"
LEFT JOIN "${vt.table}" v_age ON p2."${pt.idColumn}" = v_age."${vt.patientIdColumn}"
${parts.whereClause}
GROUP BY "${vt.table}"."${vt.patientIdColumn}", p2."${pt.idColumn}"${pt.genderColumn ? `, p2."${pt.genderColumn}"` : ''}${buildBirthGroupBy('p2', pt)}`
  }

  // No cohort
  const genderCol = pt.genderColumn ? `, p."${pt.genderColumn}" AS gender` : ''

  if (vt) {
    const ageExpr = buildAgeExprAlias('p', pt, `MIN(v."${vt.startDateColumn}")`)
    const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''
    return `SELECT p."${pt.idColumn}" AS patient_id${genderCol}${ageCol},
  COUNT(DISTINCT v."${vt.idColumn}") AS visit_count,
  MIN(v."${vt.startDateColumn}") AS first_admission
FROM "${pt.table}" p
LEFT JOIN "${vt.table}" v ON p."${pt.idColumn}" = v."${vt.patientIdColumn}"
GROUP BY p."${pt.idColumn}"${pt.genderColumn ? `, p."${pt.genderColumn}"` : ''}${buildBirthGroupBy('p', pt)}`
  }

  const ageExpr = buildAgeExprAlias('p', pt, 'CURRENT_DATE')
  const ageCol = ageExpr ? `, ${ageExpr} AS age` : ''
  return `SELECT p."${pt.idColumn}" AS patient_id${genderCol}${ageCol}
FROM "${pt.table}" p`
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

  return clauses.length > 0
    ? `\nWHERE ${clauses.join(' AND ')}`
    : ''
}

/**
 * Build age expression relative to a reference date expression.
 * @param refDateExpr SQL expression for the reference date (e.g. a column or CURRENT_DATE)
 */
function buildAgeExpr(
  pt: NonNullable<SchemaMapping['patientTable']>,
  refDateExpr: string,
): string | null {
  if (pt.birthDateColumn) {
    return `DATE_PART('year', ${refDateExpr}) - DATE_PART('year', "${pt.birthDateColumn}")`
  }
  if (pt.birthYearColumn) {
    return `DATE_PART('year', (${refDateExpr})::TIMESTAMP) - "${pt.birthYearColumn}"`
  }
  return null
}

function buildAgeExprAlias(
  alias: string,
  pt: NonNullable<SchemaMapping['patientTable']>,
  refDateExpr: string,
): string | null {
  if (pt.birthDateColumn) {
    return `DATE_PART('year', ${refDateExpr}) - DATE_PART('year', ${alias}."${pt.birthDateColumn}")`
  }
  if (pt.birthYearColumn) {
    return `DATE_PART('year', (${refDateExpr})::TIMESTAMP) - ${alias}."${pt.birthYearColumn}"`
  }
  return null
}

function buildBirthGroupBy(
  alias: string,
  pt: NonNullable<SchemaMapping['patientTable']>,
): string {
  if (pt.birthDateColumn) return `, ${alias}."${pt.birthDateColumn}"`
  if (pt.birthYearColumn) return `, ${alias}."${pt.birthYearColumn}"`
  return ''
}

/** Build IN condition for concept matching (standard + source columns). */
function buildConceptInCondition(
  alias: string,
  et: EventTable,
  idList: string,
): string {
  const parts = [`${alias}."${et.conceptIdColumn}" IN (${idList})`]
  if (et.sourceConceptIdColumn) {
    parts.push(`${alias}."${et.sourceConceptIdColumn}" IN (${idList})`)
  }
  return parts.join(' OR ')
}

/** Build visit filter clause for event table queries. */
function buildVisitFilter(
  mapping: SchemaMapping,
  visitId: string | null,
  alias: string,
): string {
  if (!visitId || !mapping.visitTable) return ''
  // Try to find a visit FK column in the event table
  // Convention: same name as visit table's idColumn (e.g., visit_occurrence_id, hadm_id)
  const visitIdCol = mapping.visitTable.idColumn
  return `\n  AND ${alias}."${visitIdCol}" = '${escSql(visitId)}'`
}

