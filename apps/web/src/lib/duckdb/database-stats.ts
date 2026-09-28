import { queryDataSource, discoverTables } from './engine'
import { quoteTableRef } from '@/lib/format-helpers'
import { specTables } from '@/lib/schema-classes/spec'
import type {
  DatabaseStatsCache,
  AgePyramidBucket,
  GenderDistribution,
  TableRowCount,
  AdmissionTimelineBucket,
  DescriptiveStats,
} from '@/types'
import type { SchemaMapping } from '@/types'
import { classRelation, has, type ClassRelation } from '@/lib/schema-classes/relations'

/**
 * Age in whole years at `refDate` (SQL), from the patient relation aliased `p`:
 * the exact birth date when present, else the birth year — OMOP maps both, and
 * MIMIC-IV leaves every birth_datetime empty. Null when neither is mapped.
 */
function ageAt(patient: ClassRelation, refDate: string): string | null {
  if (!has(patient, 'birth_year')) return null
  const byYear = `EXTRACT(YEAR FROM ${refDate}::TIMESTAMP) - p.birth_year`
  return has(patient, 'birth_date')
    ? `COALESCE(EXTRACT(YEAR FROM AGE(${refDate}::TIMESTAMP, p.birth_date::TIMESTAMP)), ${byYear})`
    : byYear
}

/**
 * Compute the "fast" database statistics — everything except per-table row
 * counts. These 5 blocks run in parallel and return in a few seconds even on a
 * large warehouse; the slow per-table counts are streamed separately (see
 * streamTableCounts) so the panel can render before they finish.
 */
export async function computeDatabaseStats(
  dataSourceId: string,
  mapping: SchemaMapping,
  signal?: AbortSignal,
): Promise<DatabaseStatsCache> {
  const [summary, genderDistribution, agePyramid, admissionTimeline, descriptiveStats] =
    await Promise.all([
      computeSummary(dataSourceId, mapping, signal),
      computeGenderDistribution(dataSourceId, mapping, signal),
      computeAgePyramid(dataSourceId, mapping, signal),
      computeAdmissionTimeline(dataSourceId, mapping, signal),
      computeDescriptiveStats(dataSourceId, mapping, signal),
    ])
  // The blocks swallow their own failures, so an interrupted run would come
  // back as zeros: refuse it rather than let it replace the stored figures.
  signal?.throwIfAborted()

  return {
    dataSourceId,
    computedAt: new Date().toISOString(),
    summary,
    genderDistribution,
    agePyramid,
    admissionTimeline,
    descriptiveStats,
    tableCounts: [],
  }
}

async function safeQueryCount(dsId: string, table: string, signal?: AbortSignal): Promise<number> {
  try {
    const rows = await queryDataSource(dsId, `SELECT COUNT(*) as cnt FROM ${quoteTableRef(table)}`, { signal })
    return Number(rows[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

async function computeSummary(
  dsId: string,
  mapping: SchemaMapping,
  signal?: AbortSignal,
): Promise<DatabaseStatsCache['summary']> {
  const tables = await discoverTables(dsId)
  const tableCount = tables.length

  const count = async (rel: ClassRelation | undefined) => (rel ? safeQueryCount(dsId, rel.name, signal) : 0)
  const patientCount = await count(classRelation(mapping, 'patient'))
  const visitCount = await count(classRelation(mapping, 'visit'))
  const visitDetailCount = await count(classRelation(mapping, 'visit_detail'))

  return { patientCount, visitCount, visitDetailCount, tableCount }
}

/** Compute gender distribution from patient table. */
async function computeGenderDistribution(
  dsId: string,
  mapping: SchemaMapping,
  signal?: AbortSignal,
): Promise<GenderDistribution> {
  const patient = classRelation(mapping, 'patient')
  if (!has(patient, 'gender')) return { male: 0, female: 0, other: 0 }

  try {
    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE gender = 'male')::INTEGER as male,
        COUNT(*) FILTER (WHERE gender = 'female')::INTEGER as female,
        COUNT(*) FILTER (WHERE gender = 'unknown')::INTEGER as other
      FROM ${patient!.name}
    `
    const rows = await queryDataSource(dsId, sql, { signal })
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
  signal?: AbortSignal,
): Promise<AgePyramidBucket[]> {
  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')
  if (!patient || !visit || !has(patient, 'gender')) return []
  const age = ageAt(patient, 'v.start_datetime')
  if (!age) return []

  const sql = `
    SELECT age_group,
           COUNT(*) FILTER (WHERE gender = 'male')::INTEGER as male,
           COUNT(*) FILTER (WHERE gender = 'female')::INTEGER as female
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
        p.gender
      FROM ${visit.name} v
      JOIN ${patient.name} p ON v.patient_id = p.patient_id
      CROSS JOIN LATERAL (
        SELECT ${age} as age
      ) ages
      WHERE ages.age >= 0 AND ages.age < 150
    ) sub
    GROUP BY age_group
    ORDER BY age_group
  `
  try {
    const rows = await queryDataSource(dsId, sql, { signal })
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
  signal?: AbortSignal,
): Promise<AdmissionTimelineBucket[]> {
  const visit = classRelation(mapping, 'visit')
  if (!visit) return []

  const sql = `
    SELECT
      STRFTIME(start_datetime::TIMESTAMP, '%Y-%m') as month,
      COUNT(*)::INTEGER as count
    FROM ${visit.name}
    WHERE start_datetime IS NOT NULL
    GROUP BY month
    ORDER BY month
  `
  try {
    const rows = await queryDataSource(dsId, sql, { signal })
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
  signal?: AbortSignal,
): Promise<DescriptiveStats> {
  const stats: DescriptiveStats = {}
  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')

  if (!patient || !visit) return stats

  // Age stats (at first visit)
  const age = ageAt(patient, 'MIN(vo.start_datetime)')
  if (age) {
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
          SELECT p.patient_id, ${age} as age
          FROM ${patient.name} p
          JOIN ${visit.name} vo ON vo.patient_id = p.patient_id
          WHERE vo.start_datetime IS NOT NULL
          GROUP BY p.patient_id, p.birth_date, p.birth_year
        ) sub
        WHERE age >= 0 AND age < 150
      `
      const rows = await queryDataSource(dsId, ageSql, { signal })
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
        MIN(start_datetime)::VARCHAR as date_min,
        MAX(start_datetime)::VARCHAR as date_max
      FROM ${visit.name}
      WHERE start_datetime IS NOT NULL
    `
    const rows = await queryDataSource(dsId, dateSql, { signal })
    if (rows[0]) {
      stats.admissionDateMin = rows[0].date_min ? String(rows[0].date_min) : undefined
      stats.admissionDateMax = rows[0].date_max ? String(rows[0].date_max) : undefined
    }
  } catch { /* ignore */ }

  // Discharge date range and length of stay
  if (has(visit, 'end_datetime')) {
    try {
      const losSql = `
        SELECT
          MIN(end_datetime)::VARCHAR as discharge_min,
          MAX(end_datetime)::VARCHAR as discharge_max,
          ROUND(AVG(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_mean,
          ROUND(MEDIAN(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_median
        FROM ${visit.name}
        WHERE start_datetime IS NOT NULL
          AND end_datetime IS NOT NULL
      `
      const rows = await queryDataSource(dsId, losSql, { signal })
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
        SELECT patient_id, COUNT(*)::INTEGER as visit_count
        FROM ${visit.name}
        GROUP BY patient_id
      ) sub
    `
    const rows = await queryDataSource(dsId, vpSql, { signal })
    if (rows[0]) {
      stats.visitsPerPatientMean = rows[0].vp_mean != null ? Number(rows[0].vp_mean) : undefined
      stats.visitsPerPatientMedian = rows[0].vp_median != null ? Number(rows[0].vp_median) : undefined
      stats.visitsPerPatientMin = rows[0].vp_min != null ? Number(rows[0].vp_min) : undefined
      stats.visitsPerPatientMax = rows[0].vp_max != null ? Number(rows[0].vp_max) : undefined
    }
  } catch { /* ignore */ }

  // Visit unit (visit_detail) length of stay
  const vd = classRelation(mapping, 'visit_detail')
  if (vd && has(vd, 'end_datetime')) {
    try {
      const unitLosSql = `
        SELECT
          ROUND(AVG(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_mean,
          ROUND(MEDIAN(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_median
        FROM ${vd.name}
        WHERE start_datetime IS NOT NULL
          AND end_datetime IS NOT NULL
      `
      const rows = await queryDataSource(dsId, unitLosSql, { signal })
      if (rows[0]) {
        stats.unitLosMean = rows[0].los_mean != null ? Number(rows[0].los_mean) : undefined
        stats.unitLosMedian = rows[0].los_median != null ? Number(rows[0].los_median) : undefined
      }
    } catch { /* ignore */ }
  }

  return stats
}

/** The tables named by the schema mapping, in priority order — these are the
 *  ones the user most likely cares about, so they get counted first. */
function mappedTableNames(mapping: SchemaMapping): string[] {
  const names = [mapping.patient, mapping.visit, mapping.visitDetail, ...(mapping.events ?? []), ...(mapping.drugs ?? [])]
    .map((spec) => specTables(spec)[0]?.table)
    .filter((t): t is string => !!t)
  return [...new Set(names)]
}

/**
 * Count rows for every table, streaming results by batch instead of blocking on
 * the whole set. Mapped tables are counted first (so the interesting rows show
 * up first), then the rest; each batch runs its COUNT(*)s concurrently and is
 * handed to `onBatch` as it completes. Returns the full list at the end.
 */
export async function streamTableCounts(
  dsId: string,
  mapping: SchemaMapping,
  onBatch: (counts: TableRowCount[]) => void,
  batchSize = 6,
  signal?: AbortSignal,
): Promise<TableRowCount[]> {
  const all = await discoverTables(dsId)
  const mapped = mappedTableNames(mapping).filter((t) => all.includes(t))
  const rest = all.filter((t) => !mapped.includes(t)).sort((a, b) => a.localeCompare(b))
  const ordered = [...mapped, ...rest]

  const results: TableRowCount[] = []
  for (let i = 0; i < ordered.length; i += batchSize) {
    const batch = ordered.slice(i, i + batchSize)
    const counts = await Promise.all(
      batch.map(async (table) => ({
        tableName: table,
        rowCount: await safeQueryCount(dsId, table, signal),
      })),
    )
    signal?.throwIfAborted()
    results.push(...counts)
    onBatch(counts)
  }
  return results
}
