import i18n from '@/lib/i18n'
import { localized } from '@/lib/localized'
import { buildAttritionQueries, buildCohortResultsSql, buildCustomSqlOutputSql, cohortIdColumn } from '@/lib/duckdb/cohort-query'
import { cohortRelationNarrowing } from '@/features/projects/warehouse/cohorts/relation-narrowing'
import { relationsCountedAt } from '@/features/projects/warehouse/patient-data/timeline-relations'
import { signatureOf, type PlanResults, type QueryPlan } from '@/lib/server-runs/query-plan'
import type { Cohort, CohortExecutionResult, CustomSqlOutput, SchemaMapping } from '@/types'

/** Result rows loaded per run. Matches the server's MAX_QUERY_ROWS (see
 *  `database.py`), which silently truncates anything larger — asking for more
 *  would report a page as complete when it isn't. */
export const MAX_RESULT_ROWS = 10_000
/** The query as written, run on its own so its rows show even when they list no member. */
export const OUTPUT_KEY = 'output'
const RESULTS_KEY = 'results'

type Assembled = Pick<CohortExecutionResult, 'totalCount' | 'attrition' | 'rows' | 'sql' | 'narrowedBy'>

export interface CompiledCohortRun {
  /** Its queries, independent of one another: a `cohort_run` on the server. */
  plan: QueryPlan
  /** The result from what they returned; the members' query or a step that failed fails it. */
  assemble: (results: PlanResults) => Assembled
  /** The generated query's output — the members' ids, just read — when no SQL is written. */
  ownOutput: (result: Assembled) => Omit<CustomSqlOutput, 'durationMs'> | null
}

/**
 * A cohort's run: its SQL as written (a hand-written cohort), its members and
 * count, then its attrition steps — the last step keeps every criterion, the
 * cohort itself, counted by the members' query. Null when the criteria produce
 * nothing runnable.
 */
export async function compileCohortRun(
  cohort: Cohort,
  dataSourceId: string,
  mapping: SchemaMapping,
  draft: boolean,
): Promise<CompiledCohortRun | null> {
  const outputSql = buildCustomSqlOutputSql(cohort, MAX_RESULT_ROWS)
  // A hand-written query stands in for the criteria inside every builder.
  const narrowing = await cohortRelationNarrowing(dataSourceId, mapping, cohort)
  const resultsSql = buildCohortResultsSql(cohort, mapping, MAX_RESULT_ROWS, narrowing)
  if (!resultsSql) return null
  const narrowed = !!narrowing && resultsSql !== buildCohortResultsSql(cohort, mapping, MAX_RESULT_ROWS)
  const narrowedBy = narrowed ? { countedAt: await relationsCountedAt(dataSourceId).catch(() => null) } : undefined
  const steps = buildAttritionQueries(cohort, mapping, { narrowing })

  const items = [
    ...(outputSql ? [{ key: OUTPUT_KEY, sql: outputSql, what: 'its SQL as written, for SQL output' }] : []),
    { key: RESULTS_KEY, sql: resultsSql, what: 'members and count' },
    ...steps.slice(0, -1).map((aq, i) => ({
      key: `step_${i}`, sql: aq.sql, what: `attrition step ${i + 1}/${steps.length}: ${aq.label}`,
    })),
  ]
  const plan: QueryPlan = {
    label: i18n.t('cohorts.run_job', { name: localized(cohort.name, i18n.language) }),
    items,
    keepGoing: true,
    // The database it reads: the server checks it is the cohort's.
    meta: { signature: signatureOf([cohort.level, ...items.map((i) => i.sql)]), draft, dataSourceId },
  }

  const rowsOf = (results: PlanResults, key: string) => {
    const got = results.get(key)
    if (got instanceof Error) throw got
    return got ?? []
  }
  return {
    plan,
    assemble: (results) => {
      const rows = rowsOf(results, RESULTS_KEY).map((row) => ({ ...row }))
      const totalCount = Number(rows[0]?.cohort_total ?? 0)
      for (const row of rows) delete row.cohort_total
      let prevCount = 0
      const attrition = steps.map((aq, i) => {
        const count = i === steps.length - 1 ? totalCount : Number(rowsOf(results, `step_${i}`)[0]?.cnt ?? 0)
        const step = { nodeId: aq.nodeId, label: aq.label, count, excluded: aq.nodeId === '__total__' ? 0 : prevCount - count }
        prevCount = count
        return step
      })
      return { totalCount, attrition, rows, sql: resultsSql, ...(narrowedBy ? { narrowedBy } : {}) }
    },
    ownOutput: (result) => {
      if (outputSql || cohort.level === 'event') return null
      const column = cohortIdColumn(cohort.level)
      return { rows: result.rows.map((row) => ({ [column]: row[column] })), truncated: result.totalCount > result.rows.length }
    },
  }
}

/** The query as written's output, from its result: its rows, or its error. */
export function outputOf(results: PlanResults, startedAt: number): CustomSqlOutput {
  const got = results.get(OUTPUT_KEY)
  const durationMs = Date.now() - startedAt
  if (got instanceof Error) return { rows: [], truncated: false, error: got.message, durationMs }
  const rows = got ?? []
  return { rows, truncated: rows.length >= MAX_RESULT_ROWS, durationMs }
}
