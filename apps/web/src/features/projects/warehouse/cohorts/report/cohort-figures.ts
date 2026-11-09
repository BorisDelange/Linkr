import { useEffect, useRef } from 'react'
import i18n from '@/lib/i18n'
import { isServerMode } from '@/lib/api-client'
import * as engine from '@/lib/duckdb/engine'
import { cohortFiguresQueries, computeCohortReportData, withReportFlow, type CohortReportData } from '@/lib/cohort-report/model'
import { followServerPlan, preparePlan, signatureOf, type PlanResults, type QueryPlan } from '@/lib/server-runs/query-plan'
import type { Cohort, DataSource, SchemaMapping } from '@/types'
import { reportDataKey, reportRunOf, startReportRun, stopReportRun, useReportRun, type ReportRunState } from './report-runs'
import { cohortOrigin } from '@/lib/duckdb/query-log'
import { localized } from '@/lib/localized'

interface FiguresOptions {
  /** The attrition steps too, which only the report shows. */
  withFlow: boolean
  /** Read everything again, even what this definition already has. */
  fresh?: boolean
  /** The cohort run the figures go with (its `executedAt`). */
  runAt?: string
}

/** The cohort run each cohort's figures were computed with. */
const computedFor = new Map<string, string | undefined>()

/**
 * Compute the figures of `cohort` on `source`. Those this definition already
 * has are kept and only completed: the Statistics tab's figures make the
 * report's, which adds its attrition steps.
 */
export function startCohortFigures(cohort: Cohort, source: DataSource, opts: FiguresOptions): void {
  const mapping = source.schemaMapping
  if (!mapping) return
  const key = reportDataKey(source.id, cohort)
  const prior = reportRunOf(cohort.id)
  const base = !opts.fresh && prior?.key === key && prior.state.status === 'done' ? prior.state.data : undefined
  if (opts.runAt !== undefined) computedFor.set(cohort.id, opts.runAt)
  startReportRun(cohort.id, key, async (signal) => {
    if (isServerMode()) return figuresOnServer(cohort, source.id, mapping, { withFlow: opts.withFlow, base, fresh: !!opts.fresh, signal })
    const named = cohortOrigin(localized(cohort.name, 'en'), opts.withFlow ? 'Cohort report' : 'Cohort statistics')
    const run = (sql: string, what = 'figures') => engine.queryDataSource(source.id, sql, { heavy: true, signal, origin: named(what) })
    const data = base ?? await computeCohortReportData({ cohort, mapping, run, combine: true })
    return opts.withFlow ? withReportFlow(data, { cohort, mapping, run }) : data
  }, base)
}

/**
 * Server mode: the figures as a `cohort_figures` run, which a reload or a
 * closed report leaves going on. The run of this definition going on is
 * joined, and — unless asked `fresh` — one that ended meanwhile is read rather
 * than computed again.
 */
async function figuresOnServer(
  cohort: Cohort,
  sourceId: string,
  mapping: SchemaMapping,
  { withFlow, base, fresh, signal }: { withFlow: boolean; base?: CohortReportData; fresh: boolean; signal: AbortSignal },
): Promise<CohortReportData> {
  const { items, assemble } = cohortFiguresQueries({ cohort, mapping, withFlow, base })
  if (items.length === 0) return assemble(new Map(), new Date().toISOString())
  const name = localized(cohort.name, i18n.language)
  const plan: QueryPlan = await preparePlan(sourceId, {
    label: i18n.t(withFlow ? 'cohorts.report_job' : 'cohorts.figures_job', { name }),
    items,
    meta: { signature: signatureOf([sourceId, ...items.map((i) => i.sql)]), dataSourceId: sourceId },
  })
  const results: PlanResults = new Map()
  const onRows = (i: number, rows: Record<string, unknown>[] | null, error?: string) =>
    results.set(plan.items[i].key, error !== undefined || !rows ? new Error(error ?? 'no rows') : rows)
  const run = (!fresh && await followServerPlan('cohort_figures', cohort.id, plan, onRows, { signal, resumeOnly: true, finished: true }))
    || await followServerPlan('cohort_figures', cohort.id, plan, onRows, { signal })
  if (!run) throw new Error('the cohort figures did not start')
  if (run.status === 'cancelled' || run.status === 'paused') throw new DOMException('cancelled', 'AbortError')
  if (run.status !== 'done') throw new Error(run.error ?? `the cohort figures ended ${run.status}`)
  return assemble(results, run.finishedAt ?? new Date().toISOString())
}

export interface CohortFigures {
  /** The figures of this definition, or null: not computed, or not yet. */
  data: CohortReportData | null
  /** The run of this definition; null when there is none. */
  state: ReportRunState | null
  recompute: () => void
  stop: () => void
}

/**
 * The figures of `cohort` as it is defined, computed when first asked for
 * (`enabled`) and shared with every other reader of the same definition. Given
 * `runAt`, the cohort run they go with, a new run reads them again. A run
 * stopped or failed waits for `recompute`, or the cohort's next run.
 */
export function useCohortFigures(
  cohort: Cohort | null,
  source: DataSource | undefined,
  opts: { withFlow: boolean; enabled: boolean; runAt?: string },
): CohortFigures {
  const run = useReportRun(cohort?.id ?? '')
  const key = cohort && source ? reportDataKey(source.id, cohort) : null
  const state = run && run.key === key ? run.state : null
  const data = state?.status === 'done' || state?.status === 'running' ? state.data ?? null : null
  const stale = !!cohort && opts.runAt !== undefined && !!state && computedFor.get(cohort.id) !== opts.runAt
  const missing = !state || stale || (state.status === 'done' && opts.withFlow && !state.data.flow)
  const ready = opts.enabled && !!cohort && !!source?.schemaMapping && cohort.level !== 'event'

  // Once per definition: two readers of different definitions of one cohort
  // (a draft, the saved one) would otherwise stop each other's run in turn.
  const asked = useRef<string | null>(null)
  useEffect(() => {
    const ask = `${key}|${opts.runAt ?? ''}`
    if (!ready || !missing || asked.current === ask) return
    asked.current = ask
    startCohortFigures(cohort!, source!, { withFlow: opts.withFlow, fresh: stale, runAt: opts.runAt })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, missing, key, opts.withFlow, opts.runAt])

  return {
    data,
    state,
    recompute: () => { if (cohort && source) startCohortFigures(cohort, source, { withFlow: opts.withFlow, fresh: true }) },
    stop: () => { if (cohort) stopReportRun(cohort.id) },
  }
}
