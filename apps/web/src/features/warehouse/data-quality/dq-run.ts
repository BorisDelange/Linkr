/**
 * A rule set's run, kept going while its page is not shown (`lib/run-registry`).
 *
 * Server mode: the checks run as one server query job, so no check outlasts a
 * gateway's timeout and none runs beside another heavy query. The job id is
 * remembered in this browser: a page opened again after the tab was closed
 * follows the job instead of losing the run. A failing check does not stop the
 * others (`keepGoing`). Front-only mode runs them one after the other in
 * DuckDB-WASM.
 */

import { isServerMode } from '@/lib/api-client'
import { createRunRegistry, type RunSnapshotBase } from '@/lib/run-registry'
import { runQueryJob } from '@/lib/duckdb/run-query-job'
import {
  checkPushdown,
  checkReport,
  checkResult,
  runAllChecks,
  type DqCheck,
  type DqCheckResult,
  type DqReport,
} from '@/lib/duckdb/data-quality'

export interface DqRunSnapshot extends RunSnapshotBase {
  done: number
  total: number
  /** Percent of its data the check in flight has read, when the database can tell. */
  reading: number | null
}

export interface DqRunInput {
  ruleSetId: string
  dataSourceId: string
  checks: DqCheck[]
  /** The job's name in the jobs panel. */
  label: string
  /** Before the first check (mount the database). */
  prepare: () => Promise<void>
  /** The finished report, recorded wherever the page records it. */
  onComplete: (report: DqReport) => void
  /** Only follow the job a closed tab left, if it still exists: nothing else, no error. */
  resumeOnly?: boolean
}

const IDLE: DqRunSnapshot = { running: false, error: null, done: 0, total: 0, reading: null }

/** Where a rule set's run job is remembered in this browser. */
export const dqJobName = (ruleSetId: string) => `dq-run:${ruleSetId}`

/** The last report of each rule set's run, for a view that mounts after it ended. */
const reports = new Map<string, DqReport>()
export const lastDqReport = (ruleSetId: string) => reports.get(ruleSetId) ?? null

async function execute(input: DqRunInput, signal: AbortSignal, emit: (patch: Partial<DqRunSnapshot>, immediate?: boolean) => void): Promise<void> {
  const { ruleSetId, dataSourceId, checks } = input
  emit({ done: 0, total: checks.length, reading: null }, true)
  await input.prepare()
  signal.throwIfAborted()

  let report: DqReport
  if (!isServerMode()) {
    report = await runAllChecks(dataSourceId, checks, (done) => emit({ done }))
  } else {
    const results: DqCheckResult[] = []
    const outcome = await runQueryJob(
      dataSourceId,
      input.label,
      checks.map((c, i) => ({ key: `c${i}`, sql: c.sql, pushdown: checkPushdown(c) })),
      (i, rows, { ms, error }) => {
        results.push(checkResult(checks[i], rows, ms ?? 0, error))
        emit({ done: results.length, reading: null })
      },
      {
        signal,
        keepGoing: true,
        remember: { name: dqJobName(ruleSetId), signature: checks.map((c) => c.id).join(',') },
        resumeOnly: input.resumeOnly,
        onWaiting: (_, reading) => emit({ reading }),
      },
    )
    if (!outcome) return
    if (outcome.delivered < checks.length) {
      // Cancelled from the jobs panel: a stop, not a failure.
      if (outcome.status === 'cancelled' || input.resumeOnly) return
      throw new Error(outcome.error ?? `the job ended ${outcome.status}`)
    }
    report = checkReport(dataSourceId, checks, results)
  }
  reports.set(ruleSetId, report)
  input.onComplete(report)
}

const registry = createRunRegistry<DqRunInput, DqRunSnapshot>({ idle: IDLE, execute })

export const getDqRun = registry.get
export const watchDqRun = registry.watch
export const stopDqRun = registry.pause
export const clearDqRunError = registry.clearError

export function startDqRun(input: DqRunInput): void {
  registry.clearError(input.ruleSetId)
  reports.delete(input.ruleSetId)
  registry.start(input.ruleSetId, input)
}
