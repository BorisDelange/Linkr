import { useSyncExternalStore } from 'react'
import type { CohortReportModel } from '@/lib/cohort-report/model'

/**
 * The report being generated for each cohort, outside its dialog: closing the
 * dialog lets the generation go on, and opening it again on the same cohort and
 * settings finds it — still running, or done — instead of starting over. One
 * per cohort: a new one stops the previous one's queries, as Stop does.
 */

export type ReportRunState =
  | { status: 'running' }
  | { status: 'done'; model: CohortReportModel }
  | { status: 'error'; error: unknown }
  | { status: 'stopped' }

export interface ReportRun {
  /** What the run was asked for: the database, the definition, the settings. */
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

/** Generate the report of `cohortId` for `key`, stopping any other one of it. */
export function startReportRun(
  cohortId: string,
  key: string,
  build: (signal: AbortSignal) => Promise<CohortReportModel>,
): void {
  runs.get(cohortId)?.controller.abort()
  const entry: Entry = { key, state: { status: 'running' }, controller: new AbortController() }
  runs.set(cohortId, entry)
  notify()
  const { signal } = entry.controller
  build(signal).then(
    (model) => settle(cohortId, entry, { status: 'done', model }),
    (error) => settle(cohortId, entry, signal.aborted ? { status: 'stopped' } : { status: 'error', error }),
  )
}

/** Stop the report of `cohortId` being generated: its queries are cancelled. */
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
