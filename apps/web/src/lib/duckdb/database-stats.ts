import { queryDataSource, discoverTables } from './engine'
import type {
  DatabaseStatsCache,
  AgePyramidBucket,
  GenderDistribution,
  TableRowCount,
  AdmissionTimelineBucket,
  DescriptiveStats,
} from '@/types'
import type { SchemaMapping } from '@/types'

/** Compute full database statistics for a data source using its schema mapping. */
export async function computeDatabaseStats(
  dataSourceId: string,
  mapping: SchemaMapping,
): Promise<DatabaseStatsCache> {
  const [summary, genderDistribution, agePyramid, admissionTimeline, descriptiveStats, tableCounts] =
    await Promise.all([
      computeSummary(dataSourceId, mapping),
      computeGenderDistribution(dataSourceId, mapping),
      computeAgePyramid(dataSourceId, mapping),
      computeAdmissionTimeline(dataSourceId, mapping),
      computeDescriptiveStats(dataSourceId, mapping),
      computeTableCounts(dataSourceId),
    ])

  return {
    dataSourceId,
    computedAt: new Date().toISOString(),
    summary,
    genderDistribution,
    agePyramid,
    admissionTimeline,
    descriptiveStats,
    tableCounts,
  }
}

async function safeQueryCount(dsId: string, table: string): Promise<number> {
  try {
    const rows = await queryDataSource(dsId, `SELECT COUNT(*) as cnt FROM "${table}"`)
    return Number(rows[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

async function computeSummary(
  dsId: string,
  mapping: SchemaMapping,
): Promise<DatabaseStatsCache['summary']> {
  const tables = await discoverTables(dsId)
  const tableCount = tables.length

  const patientCount = mapping.patientTable
    ? await safeQueryCount(dsId, mapping.patientTable.table)
    : 0
  const visitCount = mapping.visitTable
    ? await safeQueryCount(dsId, mapping.visitTable.table)
    : 0
  const visitDetailCount = mapping.visitDetailTable
    ? await safeQueryCount(dsId, mapping.visitDetailTable.table)
    : 0

  return { patientCount, visitCount, visitDetailCount, tableCount }
}

/** Compute gender distribution from patient table. */
async function computeGenderDistribution(
  dsId: string,
  mapping: SchemaMapping,
): Promise<GenderDistribution> {
  const pt = mapping.patientTable
  const gv = mapping.genderValues
  if (!pt || !pt.genderColumn || !gv) return { male: 0, female: 0, other: 0 }

  try {
    const sql = `
      SELECT
        SUM(CASE WHEN "${pt.genderColumn}" = '${gv.male}' THEN 1 ELSE 0 END)::INTEGER as male,
        SUM(CASE WHEN "${pt.genderColumn}" = '${gv.female}' THEN 1 ELSE 0 END)::INTEGER as female,
        SUM(CASE WHEN "${pt.genderColumn}" NOT IN ('${gv.male}', '${gv.female}') THEN 1 ELSE 0 END)::INTEGER as other
      FROM "${pt.table}"
    `
    const rows = await queryDataSource(dsId, sql)
    if (rows[0]) {
      return {
        male: Number(rows[0].male ?? 0),
        female: Number(rows[0].female ?? 0),
        other: Number(rows[0].other ?? 0),
      }
    }
  } catch { /* ignore */ }
  return { male: 0, female: 0, other: 0 }
}

/**
 * Compute age pyramid using visit-level ages.
 * Uses the visit table for age calculation.
 */
async function computeAgePyramid(
  dsId: string,
  mapping: SchemaMapping,
): Promise<AgePyramidBucket[]> {
  const pt = mapping.patientTable
  if (!pt) return []

  const gv = mapping.genderValues
  if (!gv || !pt.genderColumn) return []

  const vt = mapping.visitTable
  if (!vt) return []

  const visitTable = vt.table
  const startDateCol = vt.startDateColumn
  const patientIdCol = vt.patientIdColumn

  if (!visitTable || !startDateCol || !patientIdCol) return []

  // Use birth_datetime if available, otherwise fall back to year_of_birth
  const birthExpr = pt.birthDateColumn
    ? `EXTRACT(YEAR FROM AGE(v."${startDateCol}"::TIMESTAMP, p."${pt.birthDateColumn}"::TIMESTAMP))`
    : pt.birthYearColumn
      ? `EXTRACT(YEAR FROM v."${startDateCol}"::TIMESTAMP) - p."${pt.birthYearColumn}"`
      : null
  if (!birthExpr) return []

  const sql = `
    SELECT age_group,
           SUM(CASE WHEN "${pt.genderColumn}" = '${gv.male}' THEN 1 ELSE 0 END)::INTEGER as male,
           SUM(CASE WHEN "${pt.genderColumn}" = '${gv.female}' THEN 1 ELSE 0 END)::INTEGER as female
    FROM (
      SELECT
        CASE
          WHEN age < 10 THEN '00-09'
          WHEN age < 20 THEN '10-19'
          WHEN age < 30 THEN '20-29'
          WHEN age < 40 THEN '30-39'
          WHEN age < 50 THEN '40-49'
          WHEN age < 60 THEN '50-59'
          WHEN age < 70 THEN '60-69'
          WHEN age < 80 THEN '70-79'
          WHEN age < 90 THEN '80-89'
          ELSE '90+'
        END as age_group,
        p."${pt.genderColumn}"
      FROM "${visitTable}" v
      JOIN "${pt.table}" p ON v."${patientIdCol}" = p."${pt.idColumn}"
      CROSS JOIN LATERAL (
        SELECT ${birthExpr} as age
      ) ages
      WHERE ages.age >= 0 AND ages.age < 150
    ) sub
    GROUP BY age_group
    ORDER BY age_group
  `
  try {
    const rows = await queryDataSource(dsId, sql)
    return rows.map((r) => ({
      ageGroup: String(r.age_group),
      male: Number(r.male ?? 0),
      female: Number(r.female ?? 0),
    }))
  } catch {
    return []
  }
}

/** Compute monthly admission timeline from visit table. */
async function computeAdmissionTimeline(
  dsId: string,
  mapping: SchemaMapping,
): Promise<AdmissionTimelineBucket[]> {
  const vt = mapping.visitTable
  if (!vt) return []

  const sql = `
    SELECT
      STRFTIME("${vt.startDateColumn}"::TIMESTAMP, '%Y-%m') as month,
      COUNT(*)::INTEGER as count
    FROM "${vt.table}"
    WHERE "${vt.startDateColumn}" IS NOT NULL
    GROUP BY month
    ORDER BY month
  `
  try {
    const rows = await queryDataSource(dsId, sql)
    return rows.map((r) => ({
      month: String(r.month),
      count: Number(r.count ?? 0),
    }))
  } catch {
    return []
  }
}

/** Compute descriptive statistics. */
async function computeDescriptiveStats(
  dsId: string,
  mapping: SchemaMapping,
): Promise<DescriptiveStats> {
  const stats: DescriptiveStats = {}
  const pt = mapping.patientTable
  const vt = mapping.visitTable

  if (!pt || !vt) return stats

  // Age stats (at first visit)
  const birthExpr = pt.birthDateColumn
    ? `EXTRACT(YEAR FROM AGE(MIN(vo."${vt.startDateColumn}")::TIMESTAMP, p."${pt.birthDateColumn}"::TIMESTAMP))`
    : pt.birthYearColumn
      ? `EXTRACT(YEAR FROM MIN(vo."${vt.startDateColumn}")::TIMESTAMP) - p."${pt.birthYearColumn}"`
      : null

  if (birthExpr) {
    try {
      const ageSql = `
        SELECT
          ROUND(AVG(age), 1) as age_mean,
          ROUND(MEDIAN(age), 1) as age_median,
          MIN(age)::INTEGER as age_min,
          MAX(age)::INTEGER as age_max,
          ROUND(QUANTILE_CONT(age, 0.25), 1) as age_q1,
          ROUND(QUANTILE_CONT(age, 0.75), 1) as age_q3
        FROM (
          SELECT
            p."${pt.idColumn}",
            ${birthExpr} as age
          FROM "${pt.table}" p
          JOIN "${vt.table}" vo ON vo."${vt.patientIdColumn}" = p."${pt.idColumn}"
          WHERE vo."${vt.startDateColumn}" IS NOT NULL
          GROUP BY p."${pt.idColumn}"${pt.birthDateColumn ? `, p."${pt.birthDateColumn}"` : ''}${pt.birthYearColumn ? `, p."${pt.birthYearColumn}"` : ''}
        ) sub
        WHERE age >= 0 AND age < 150
      `
      const rows = await queryDataSource(dsId, ageSql)
      if (rows[0]) {
        stats.ageMean = rows[0].age_mean != null ? Number(rows[0].age_mean) : undefined
        stats.ageMedian = rows[0].age_median != null ? Number(rows[0].age_median) : undefined
        stats.ageMin = rows[0].age_min != null ? Number(rows[0].age_min) : undefined
        stats.ageMax = rows[0].age_max != null ? Number(rows[0].age_max) : undefined
        stats.ageQ1 = rows[0].age_q1 != null ? Number(rows[0].age_q1) : undefined
        stats.ageQ3 = rows[0].age_q3 != null ? Number(rows[0].age_q3) : undefined
      }
    } catch { /* ignore */ }
  }

  // Admission date range
  try {
    const dateSql = `
      SELECT
        MIN("${vt.startDateColumn}")::VARCHAR as date_min,
        MAX("${vt.startDateColumn}")::VARCHAR as date_max
      FROM "${vt.table}"
      WHERE "${vt.startDateColumn}" IS NOT NULL
    `
    const rows = await queryDataSource(dsId, dateSql)
    if (rows[0]) {
      stats.admissionDateMin = rows[0].date_min ? String(rows[0].date_min) : undefined
      stats.admissionDateMax = rows[0].date_max ? String(rows[0].date_max) : undefined
    }
  } catch { /* ignore */ }

  // Discharge date range and length of stay
  if (vt.endDateColumn) {
    try {
      const losSql = `
        SELECT
          MIN("${vt.endDateColumn}")::VARCHAR as discharge_min,
          MAX("${vt.endDateColumn}")::VARCHAR as discharge_max,
          ROUND(AVG(DATEDIFF('day', "${vt.startDateColumn}"::TIMESTAMP, "${vt.endDateColumn}"::TIMESTAMP)), 1) as los_mean,
          ROUND(MEDIAN(DATEDIFF('day', "${vt.startDateColumn}"::TIMESTAMP, "${vt.endDateColumn}"::TIMESTAMP)), 1) as los_median
        FROM "${vt.table}"
        WHERE "${vt.startDateColumn}" IS NOT NULL
          AND "${vt.endDateColumn}" IS NOT NULL
      `
      const rows = await queryDataSource(dsId, losSql)
      if (rows[0]) {
        stats.dischargeDateMin = rows[0].discharge_min ? String(rows[0].discharge_min) : undefined
        stats.dischargeDateMax = rows[0].discharge_max ? String(rows[0].discharge_max) : undefined
        stats.losMean = rows[0].los_mean != null ? Number(rows[0].los_mean) : undefined
        stats.losMedian = rows[0].los_median != null ? Number(rows[0].los_median) : undefined
      }
    } catch { /* ignore */ }
  }

  // Visits per patient
  try {
    const vpSql = `
      SELECT
        ROUND(AVG(visit_count), 1) as vp_mean,
        ROUND(MEDIAN(visit_count), 1) as vp_median,
        MIN(visit_count)::INTEGER as vp_min,
        MAX(visit_count)::INTEGER as vp_max
      FROM (
        SELECT "${vt.patientIdColumn}", COUNT(*)::INTEGER as visit_count
        FROM "${vt.table}"
        GROUP BY "${vt.patientIdColumn}"
      ) sub
    `
    const rows = await queryDataSource(dsId, vpSql)
    if (rows[0]) {
      stats.visitsPerPatientMean = rows[0].vp_mean != null ? Number(rows[0].vp_mean) : undefined
      stats.visitsPerPatientMedian = rows[0].vp_median != null ? Number(rows[0].vp_median) : undefined
      stats.visitsPerPatientMin = rows[0].vp_min != null ? Number(rows[0].vp_min) : undefined
      stats.visitsPerPatientMax = rows[0].vp_max != null ? Number(rows[0].vp_max) : undefined
    }
  } catch { /* ignore */ }

  // Visit unit (visit_detail) length of stay
  const vdt = mapping.visitDetailTable
  if (vdt?.startDateColumn && vdt?.endDateColumn) {
    try {
      const unitLosSql = `
        SELECT
          ROUND(AVG(DATEDIFF('day', "${vdt.startDateColumn}"::TIMESTAMP, "${vdt.endDateColumn}"::TIMESTAMP)), 1) as los_mean,
          ROUND(MEDIAN(DATEDIFF('day', "${vdt.startDateColumn}"::TIMESTAMP, "${vdt.endDateColumn}"::TIMESTAMP)), 1) as los_median
        FROM "${vdt.table}"
        WHERE "${vdt.startDateColumn}" IS NOT NULL
          AND "${vdt.endDateColumn}" IS NOT NULL
      `
      const rows = await queryDataSource(dsId, unitLosSql)
      if (rows[0]) {
        stats.unitLosMean = rows[0].los_mean != null ? Number(rows[0].los_mean) : undefined
        stats.unitLosMedian = rows[0].los_median != null ? Number(rows[0].los_median) : undefined
      }
    } catch { /* ignore */ }
  }

  return stats
}

async function computeTableCounts(dsId: string): Promise<TableRowCount[]> {
  const tables = await discoverTables(dsId)
  const counts: TableRowCount[] = []
  for (const table of tables) {
    const rowCount = await safeQueryCount(dsId, table)
    counts.push({ tableName: table, rowCount })
  }
  return counts.sort((a, b) => b.rowCount - a.rowCount)
}
