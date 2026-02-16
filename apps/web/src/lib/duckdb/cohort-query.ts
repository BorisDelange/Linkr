import type {
  Cohort,
  CohortCriteria,
  CohortLevel,
  AgeCriteriaConfig,
  SexCriteriaConfig,
  PeriodCriteriaConfig,
  DurationCriteriaConfig,
} from '@/types'
import type { SchemaMapping } from '@/types'

/**
 * Result of building cohort WHERE clauses — reusable for COUNT, SELECT, etc.
 */
export interface CohortQueryParts {
  baseTable: string
  idColumn: string
  from: string
  whereClause: string
}

/**
 * Build reusable query parts (FROM + WHERE) from a Cohort definition.
 * Used by buildCohortQuery (COUNT) and patient-data-queries (SELECT list).
 */
export function buildCohortQueryParts(cohort: Cohort, mapping: SchemaMapping): CohortQueryParts | null {
  const baseTable = getBaseTable(cohort.level, mapping)
  const idColumn = getIdColumn(cohort.level, mapping)
  if (!baseTable || !idColumn) return null

  const inclusions = cohort.criteria.filter((c) => !c.exclude)
  const exclusions = cohort.criteria.filter((c) => c.exclude)

  const inclusionClauses = inclusions.map((c) => buildCriterionClause(c, cohort.level, mapping)).filter(Boolean)
  const exclusionClauses = exclusions.map((c) => buildCriterionClause(c, cohort.level, mapping)).filter(Boolean)

  let where = ''
  if (inclusionClauses.length > 0) {
    where += inclusionClauses.join(' AND ')
  }
  if (exclusionClauses.length > 0) {
    const excl = exclusionClauses.map((c) => `NOT (${c})`).join(' AND ')
    where += where ? ` AND ${excl}` : excl
  }

  const patientTable = mapping.patientTable
  const needsPatientJoin =
    cohort.level !== 'patient' &&
    patientTable &&
    cohort.criteria.some((c) => c.type === 'age' || c.type === 'sex')

  let from = `"${baseTable}"`
  if (needsPatientJoin && patientTable) {
    const patientIdCol = getPatientIdColumn(cohort.level, mapping) ?? patientTable.idColumn
    from += ` INNER JOIN "${patientTable.table}" p ON "${baseTable}"."${patientIdCol}" = p."${patientTable.idColumn}"`
  }

  return {
    baseTable,
    idColumn,
    from,
    whereClause: where ? `WHERE ${where}` : '',
  }
}

/**
 * Build a DuckDB SQL COUNT query from a Cohort definition.
 * Runs against the schema search_path set by engine.queryDataSource().
 */
export function buildCohortQuery(cohort: Cohort, mapping: SchemaMapping): string | null {
  const parts = buildCohortQueryParts(cohort, mapping)
  if (!parts) return null
  return `SELECT COUNT(DISTINCT "${parts.baseTable}"."${parts.idColumn}") AS cnt FROM ${parts.from} ${parts.whereClause}`
}

function getBaseTable(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return mapping.patientTable?.table ?? null
    case 'visit':
      return mapping.visitTable?.table ?? null
  }
}

function getIdColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return mapping.patientTable?.idColumn ?? null
    case 'visit':
      return mapping.visitTable?.idColumn ?? null
  }
}

function getPatientIdColumn(level: CohortLevel, mapping: SchemaMapping): string | null {
  switch (level) {
    case 'patient':
      return mapping.patientTable?.idColumn ?? null
    case 'visit':
      return mapping.visitTable?.patientIdColumn ?? null
  }
}

function buildCriterionClause(criterion: CohortCriteria, level: CohortLevel, mapping: SchemaMapping): string {
  switch (criterion.type) {
    case 'age': {
      const config = criterion.config as AgeCriteriaConfig
      const pt = mapping.patientTable
      if (!pt) return '1=1'

      const personRef = level === 'patient' ? `"${pt.table}"` : 'p'

      // Determine reference date for age calculation
      let dateRef: string
      if (level === 'patient') {
        dateRef = 'CURRENT_DATE'
      } else if (level === 'visit' && mapping.visitTable?.startDateColumn) {
        dateRef = `"${mapping.visitTable.table}"."${mapping.visitTable.startDateColumn}"`
      } else {
        dateRef = 'CURRENT_DATE'
      }

      // Use birth_datetime if available, otherwise year_of_birth
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

    case 'sex': {
      const config = criterion.config as SexCriteriaConfig
      if (config.values.length === 0) return '1=1'
      const pt = mapping.patientTable
      if (!pt?.genderColumn) return '1=1'
      const personRef = level === 'patient' ? `"${pt.table}"` : 'p'
      const vals = config.values.map((v) => `'${v}'`).join(', ')
      return `${personRef}."${pt.genderColumn}" IN (${vals})`
    }

    case 'period': {
      const config = criterion.config as PeriodCriteriaConfig
      let dateCol: string | null = null
      if (level === 'visit' && mapping.visitTable?.startDateColumn) {
        dateCol = `"${mapping.visitTable.table}"."${mapping.visitTable.startDateColumn}"`
      }
      if (!dateCol) return '1=1'
      const parts: string[] = []
      if (config.startDate) parts.push(`${dateCol} >= '${config.startDate}'`)
      if (config.endDate) parts.push(`${dateCol} <= '${config.endDate}'`)
      return parts.join(' AND ') || '1=1'
    }

    case 'duration': {
      const config = criterion.config as DurationCriteriaConfig
      let startCol: string | null = null
      let endCol: string | null = null
      if (level === 'visit' && mapping.visitTable) {
        startCol = `"${mapping.visitTable.table}"."${mapping.visitTable.startDateColumn}"`
        endCol = mapping.visitTable.endDateColumn
          ? `"${mapping.visitTable.table}"."${mapping.visitTable.endDateColumn}"`
          : null
      }
      if (!startCol || !endCol) return '1=1'
      const durExpr = `DATE_DIFF('day', ${startCol}, ${endCol})`
      const parts: string[] = []
      if (config.minDays != null) parts.push(`${durExpr} >= ${config.minDays}`)
      if (config.maxDays != null) parts.push(`${durExpr} <= ${config.maxDays}`)
      return parts.join(' AND ') || '1=1'
    }

    case 'concept':
      // Placeholder until Concept Browser is implemented
      return '1=1'

    default:
      return '1=1'
  }
}
