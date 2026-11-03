import { useEffect, useRef } from 'react'
import * as engine from '@/lib/duckdb/engine'
import { computeCohortReportData, withReportFlow, type CohortReportData } from '@/lib/cohort-report/model'
import type { Cohort, DataSource } from '@/types'
import { cohortRelationNarrowing } from '../relation-narrowing'
import { reportDataKey, reportRunOf, startReportRun, stopReportRun, useReportRun, type ReportRunState } from './report-runs'

interface FiguresOptions {
  /** The attrition steps too, which only the report shows. */
  withFlow: boolean
  /** Read everything again, even what this definition already has. */
  fresh?: boolean
}

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
  startReportRun(cohort.id, key, async (signal) => {
    const run = (sql: string) => engine.queryDataSource(source.id, sql, { heavy: true, signal })
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
 * (`enabled`) and shared with every other reader of the same definition. A run
 * stopped or failed waits for `recompute`.
 */
export function useCohortFigures(cohort: Cohort | null, source: DataSource | undefined, opts: { withFlow: boolean; enabled: boolean }): CohortFigures {
  const run = useReportRun(cohort?.id ?? '')
  const key = cohort && source ? reportDataKey(source.id, cohort) : null
  const state = run && run.key === key ? run.state : null
  const data = state?.status === 'done' || state?.status === 'running' ? state.data ?? null : null
  const missing = !state || (state.status === 'done' && opts.withFlow && !state.data.flow)
  const ready = opts.enabled && !!cohort && !!source?.schemaMapping && cohort.level !== 'event'

  // Once per definition: two readers of different definitions of one cohort
  // (a draft, the saved one) would otherwise stop each other's run in turn.
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !missing || asked.current === key) return
    asked.current = key
    startCohortFigures(cohort!, source!, { withFlow: opts.withFlow })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, missing, key, opts.withFlow])

  return {
    data,
    state,
    recompute: () => { if (cohort && source) startCohortFigures(cohort, source, { withFlow: opts.withFlow, fresh: true }) },
    stop: () => { if (cohort) stopReportRun(cohort.id) },
  }
}
