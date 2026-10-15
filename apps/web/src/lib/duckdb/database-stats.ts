import i18n from '@/lib/i18n'
import { isServerMode } from '@/lib/api-client'
import { queryDataSource, discoverTables } from './engine'
import { runQueryJob } from './run-query-job'
import { quoteTableRef } from '@/lib/format-helpers'
import { specTables } from '@/lib/schema-classes/spec'
import type { DatabaseStatsCache, TableRowCount } from '@/types'
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

/** One statistics query and how its rows land in the result; rows are null when it failed. */
interface StatsQuery {
  key: string
  sql: string
  apply: (rows: Record<string, unknown>[] | null, out: DatabaseStatsCache) => void
}

/**
 * Runs statistics queries and hands each one's rows over, null for one that
 * failed — a block that cannot be computed shows empty, it does not stop the
 * others. In the browser, `parallel` at a time; on a server, one query job
 * (`run-query-job.ts`), so none outlasts a gateway's timeout or runs beside
 * another heavy query, and the jobs panel can stop it.
 */
type StatsRunner = (
  queries: readonly StatsQuery[],
  onRows: (index: number, rows: Record<string, unknown>[] | null) => void,
) => Promise<void>

export interface StatsOptions {
  signal?: AbortSignal
  /** The job's name in the jobs panel (server mode). */
  label?: string
  /** Only follow the job a closed tab left (server mode); with none, stop as a stop does. */
  resumeOnly?: boolean
}

export type StatsPhase = 'stats' | 'counts'

/** Where a database's statistics job of `phase` is remembered in this browser. */
export const statsJobName = (dsId: string, phase: StatsPhase) => `stats:${dsId}:${phase}`

function statsRunner(dsId: string, phase: StatsPhase, { signal, label, resumeOnly }: StatsOptions, parallel: number): StatsRunner {
  if (!isServerMode()) {
    return async (queries, onRows) => {
      for (let i = 0; i < queries.length; i += parallel) {
        await Promise.all(queries.slice(i, i + parallel).map(async (q, j) => {
          let rows: Record<string, unknown>[] | null = null
          try {
            rows = await queryDataSource(dsId, q.sql, { signal })
          } catch { /* the block shows empty */ }
          onRows(i + j, rows)
        }))
        signal?.throwIfAborted()
      }
    }
  }
  return async (queries, onRows) => {
    const outcome = await runQueryJob(
      dsId,
      label ?? i18n.t('databases.stats_job', { name: dsId }),
      queries.map(({ key, sql }) => ({ key, sql })),
      (i, rows, { error }) => onRows(i, error == null ? rows : null),
      {
        signal: signal ?? new AbortController().signal,
        keepGoing: true,
        remember: { name: statsJobName(dsId, phase), signature: queries.map((q) => `${q.key}:${q.sql.length}`).join(',') },
        resumeOnly,
      },
    )
    if (!outcome) throw new DOMException('nothing to resume', 'AbortError')
    if (outcome.delivered === queries.length) return
    // Stopped from the jobs panel: as a stop from the page.
    if (outcome.status === 'cancelled') throw new DOMException('cancelled', 'AbortError')
    throw new Error(outcome.error ?? `the statistics job ended ${outcome.status}`)
  }
}

const num = (v: unknown) => (v != null ? Number(v) : undefined)
const str = (v: unknown) => (v ? String(v) : undefined)

/** The statistics' queries, each with where its rows go. */
function statsQueries(mapping: SchemaMapping): StatsQuery[] {
  const queries: StatsQuery[] = []
  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')
  const vd = classRelation(mapping, 'visit_detail')

  const count = (key: 'patientCount' | 'visitCount' | 'visitDetailCount', rel: ClassRelation | undefined) => {
    if (!rel) return
    queries.push({
      key,
      sql: `SELECT COUNT(*) as cnt FROM ${quoteTableRef(rel.name)}`,
      apply: (rows, out) => { out.summary[key] = Number(rows?.[0]?.cnt ?? 0) },
    })
  }
  count('patientCount', patient)
  count('visitCount', visit)
  count('visitDetailCount', vd)

  if (has(patient, 'gender')) {
    queries.push({
      key: 'gender',
      sql: `
        SELECT
          COUNT(*) FILTER (WHERE gender = 'male')::INTEGER as male,
          COUNT(*) FILTER (WHERE gender = 'female')::INTEGER as female,
          COUNT(*) FILTER (WHERE gender = 'unknown')::INTEGER as other
        FROM ${patient!.name}
      `,
      apply: (rows, out) => {
        const r = rows?.[0]
        if (r) out.genderDistribution = { male: Number(r.male ?? 0), female: Number(r.female ?? 0), other: Number(r.other ?? 0) }
      },
    })
  }

  const visitAge = patient && visit && has(patient, 'gender') ? ageAt(patient, 'v.start_datetime') : null
  if (visitAge) {
    queries.push({
      key: 'age_pyramid',
      sql: `
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
            gender
          FROM (
            SELECT ${visitAge} as age, p.gender
            FROM ${visit!.name} v
            JOIN ${patient!.name} p ON v.patient_id = p.patient_id
          ) ages
          WHERE age >= 0 AND age < 150
        ) sub
        GROUP BY age_group
        ORDER BY age_group
      `,
      apply: (rows, out) => {
        out.agePyramid = (rows ?? []).map((r) => ({ ageGroup: String(r.age_group), male: Number(r.male ?? 0), female: Number(r.female ?? 0) }))
      },
    })
  }

  if (visit) {
    queries.push({
      key: 'admission_timeline',
      sql: `
        SELECT
          STRFTIME(start_datetime::TIMESTAMP, '%Y-%m') as month,
          COUNT(*)::INTEGER as count
        FROM ${visit.name}
        WHERE start_datetime IS NOT NULL
        GROUP BY month
        ORDER BY month
      `,
      apply: (rows, out) => {
        out.admissionTimeline = (rows ?? []).map((r) => ({ month: String(r.month), count: Number(r.count ?? 0) }))
      },
    })
  }

  if (!patient || !visit) return queries
  const stats = (out: DatabaseStatsCache) => out.descriptiveStats

  // Age at first visit
  const firstAge = ageAt(patient, 'MIN(vo.start_datetime)')
  if (firstAge) {
    queries.push({
      key: 'age_stats',
      sql: `
        SELECT
          ROUND(AVG(age), 1) as age_mean,
          ROUND(MEDIAN(age), 1) as age_median,
          MIN(age)::INTEGER as age_min,
          MAX(age)::INTEGER as age_max,
          ROUND(QUANTILE_CONT(age, 0.25), 1) as age_q1,
          ROUND(QUANTILE_CONT(age, 0.75), 1) as age_q3
        FROM (
          SELECT p.patient_id, ${firstAge} as age
          FROM ${patient.name} p
          JOIN ${visit.name} vo ON vo.patient_id = p.patient_id
          WHERE vo.start_datetime IS NOT NULL
          GROUP BY p.patient_id, p.birth_date, p.birth_year
        ) sub
        WHERE age >= 0 AND age < 150
      `,
      apply: (rows, out) => {
        const r = rows?.[0]
        if (!r) return
        Object.assign(stats(out), {
          ageMean: num(r.age_mean), ageMedian: num(r.age_median), ageMin: num(r.age_min),
          ageMax: num(r.age_max), ageQ1: num(r.age_q1), ageQ3: num(r.age_q3),
        })
      },
    })
  }

  queries.push({
    key: 'admission_dates',
    sql: `
      SELECT
        MIN(start_datetime)::VARCHAR as date_min,
        MAX(start_datetime)::VARCHAR as date_max
      FROM ${visit.name}
      WHERE start_datetime IS NOT NULL
    `,
    apply: (rows, out) => {
      const r = rows?.[0]
      if (r) Object.assign(stats(out), { admissionDateMin: str(r.date_min), admissionDateMax: str(r.date_max) })
    },
  })

  if (has(visit, 'end_datetime')) {
    queries.push({
      key: 'length_of_stay',
      sql: `
        SELECT
          MIN(end_datetime)::VARCHAR as discharge_min,
          MAX(end_datetime)::VARCHAR as discharge_max,
          ROUND(AVG(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_mean,
          ROUND(MEDIAN(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_median
        FROM ${visit.name}
        WHERE start_datetime IS NOT NULL
          AND end_datetime IS NOT NULL
      `,
      apply: (rows, out) => {
        const r = rows?.[0]
        if (!r) return
        Object.assign(stats(out), {
          dischargeDateMin: str(r.discharge_min), dischargeDateMax: str(r.discharge_max),
          losMean: num(r.los_mean), losMedian: num(r.los_median),
        })
      },
    })
  }

  queries.push({
    key: 'visits_per_patient',
    sql: `
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
    `,
    apply: (rows, out) => {
      const r = rows?.[0]
      if (!r) return
      Object.assign(stats(out), {
        visitsPerPatientMean: num(r.vp_mean), visitsPerPatientMedian: num(r.vp_median),
        visitsPerPatientMin: num(r.vp_min), visitsPerPatientMax: num(r.vp_max),
      })
    },
  })

  if (vd && has(vd, 'end_datetime')) {
    queries.push({
      key: 'unit_length_of_stay',
      sql: `
        SELECT
          ROUND(AVG(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_mean,
          ROUND(MEDIAN(DATEDIFF('day', start_datetime::TIMESTAMP, end_datetime::TIMESTAMP)), 1) as los_median
        FROM ${vd.name}
        WHERE start_datetime IS NOT NULL
          AND end_datetime IS NOT NULL
      `,
      apply: (rows, out) => {
        const r = rows?.[0]
        if (r) Object.assign(stats(out), { unitLosMean: num(r.los_mean), unitLosMedian: num(r.los_median) })
      },
    })
  }
  return queries
}

/**
 * Compute the database statistics — everything except per-table row counts,
 * which stream in separately (streamTableCounts) so the panel renders first.
 */
export async function computeDatabaseStats(
  dataSourceId: string,
  mapping: SchemaMapping,
  options: StatsOptions = {},
): Promise<DatabaseStatsCache> {
  const out: DatabaseStatsCache = {
    dataSourceId,
    computedAt: new Date().toISOString(),
    summary: { patientCount: 0, visitCount: 0, visitDetailCount: 0, tableCount: (await discoverTables(dataSourceId)).length },
    genderDistribution: { male: 0, female: 0, other: 0 },
    agePyramid: [],
    admissionTimeline: [],
    descriptiveStats: {},
    tableCounts: [],
  }
  const queries = statsQueries(mapping)
  await statsRunner(dataSourceId, 'stats', options, queries.length)(queries, (i, rows) => queries[i].apply(rows, out))
  // A block's failure shows empty, so an interrupted run would come back as
  // zeros: refuse it rather than let it replace the stored figures.
  options.signal?.throwIfAborted()
  return out
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
  options: StatsOptions = {},
  batchSize = 6,
): Promise<TableRowCount[]> {
  const all = await discoverTables(dsId)
  const mapped = mappedTableNames(mapping).filter((t) => all.includes(t))
  const rest = all.filter((t) => !mapped.includes(t)).sort((a, b) => a.localeCompare(b))
  const ordered = [...mapped, ...rest]

  const results: TableRowCount[] = []
  const queries: StatsQuery[] = ordered.map((table, i) => ({
    key: `t${i}`,
    sql: `SELECT COUNT(*) as cnt FROM ${quoteTableRef(table)}`,
    apply: () => {},
  }))
  // A batch's counts are handed over together, as they come in the browser.
  let batch: TableRowCount[] = []
  try {
    await statsRunner(dsId, 'counts', options, batchSize)(queries, (i, rows) => {
      const count = { tableName: ordered[i], rowCount: Number(rows?.[0]?.cnt ?? 0) }
      results.push(count)
      batch.push(count)
      if (batch.length === batchSize) {
        onBatch(batch)
        batch = []
      }
    })
  } finally {
    // Stopped or not, the tables counted so far are kept.
    if (batch.length) onBatch(batch)
  }
  options.signal?.throwIfAborted()
  return results
}
