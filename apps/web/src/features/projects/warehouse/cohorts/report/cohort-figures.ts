import { useEffect, useRef } from 'react'
import * as engine from '@/lib/duckdb/engine'
import { computeCohortReportData, withReportFlow, type CohortReportData } from '@/lib/cohort-report/model'
import type { Cohort, DataSource } from '@/types'
import { cohortRelationNarrowing } from '../relation-narrowing'
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
    const named = cohortOrigin(localized(cohort.name, 'en'), opts.withFlow ? 'Cohort report' : 'Cohort statistics')
    const run = (sql: string, what = 'figures') => engine.queryDataSource(source.id, sql, { heavy: true, signal, origin: named(what) })
    const narrowing = await cohortRelationNarrowing(source.id, mapping, cohort).catch(() => undefined)
    const data = base ?? await computeCohortReportData({ cohort, mapping, run, narrowing, combine: true })
    return opts.withFlow ? withReportFlow(data, { cohort, mapping, run, narrowing }) : data
  }, base)
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
