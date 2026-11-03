import { useSyncExternalStore } from 'react'
import type { Cohort } from '@/types'
import type { CohortReportData } from '@/lib/cohort-report/model'

/**
 * The figures being computed for each cohort, outside the dialog or tab that
 * asked: closing the report lets the computation go on, and the report and the
 * Statistics tab both find it — still running, or done — under the same
 * definition instead of starting over. One per cohort: a new one stops the
 * previous one's queries, as Stop does.
 */

export type ReportRunState =
  /** `data`: figures of the same definition being completed (the attrition steps). */
  | { status: 'running'; data?: CohortReportData }
  | { status: 'done'; data: CohortReportData }
  | { status: 'error'; error: unknown }
  | { status: 'stopped' }

export interface ReportRun {
  /** What the run was asked for: the database and the definition (`reportDataKey`). */
  key: string
  state: ReportRunState
}

interface Entry extends ReportRun {
  controller: AbortController
}

const runs = new Map<string, Entry>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

function settle(cohortId: string, entry: Entry, state: ReportRunState) {
  if (runs.get(cohortId) !== entry) return
  runs.set(cohortId, { ...entry, state })
  notify()
}

/** What a cohort's figures depend on: the database and the definition — not
 *  the language nor the threshold, applied when they are shaped. */
export const reportDataKey = (sourceId: string | undefined, cohort: Cohort) =>
  JSON.stringify([sourceId, cohort.level, cohort.criteriaTree, cohort.customSql?.trim() || null])

/** Compute the figures of `cohortId` for `key`, stopping any other run of it. */
export function startReportRun(
  cohortId: string,
  key: string,
  build: (signal: AbortSignal) => Promise<CohortReportData>,
  prior?: CohortReportData,
): void {
  runs.get(cohortId)?.controller.abort()
  const entry: Entry = { key, state: { status: 'running', ...(prior ? { data: prior } : {}) }, controller: new AbortController() }
  runs.set(cohortId, entry)
  notify()
  const { signal } = entry.controller
  build(signal).then(
    (data) => settle(cohortId, entry, { status: 'done', data }),
    (error) => settle(cohortId, entry, signal.aborted ? { status: 'stopped' } : { status: 'error', error }),
  )
}

/** Stop the figures of `cohortId` being computed: its queries are cancelled. */
export function stopReportRun(cohortId: string): void {
  const entry = runs.get(cohortId)
  if (entry?.state.status !== 'running') return
  entry.controller.abort()
  settle(cohortId, entry, { status: 'stopped' })
}

export function reportRunOf(cohortId: string): ReportRun | undefined {
  return runs.get(cohortId)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The report run of `cohortId`, kept current. */
export function useReportRun(cohortId: string): ReportRun | undefined {
  return useSyncExternalStore(subscribe, () => runs.get(cohortId))
}
