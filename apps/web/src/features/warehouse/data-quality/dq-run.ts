/**
 * A rule set's or a quality profile's run.
 *
 * Server mode: a server run (`dq_rule_set`, `dq_profile`: apps/api
 * services/server_runs/dq.py) the page compiles once (`compileDqRun`) and then
 * only reads (`useServerRun`). It goes on with the page closed, pauses and
 * resumes at the check it cut, and records its history itself. A failing check
 * does not stop the others.
 *
 * Front-only mode: the checks run one after the other in DuckDB-WASM, kept going
 * while the page is not shown (`lib/run-registry`); the page records the report.
 */

import i18n from '@/lib/i18n'
import { localized } from '@/lib/localized'
import { createRunRegistry, type RunSnapshotBase } from '@/lib/run-registry'
import { preparePlan, signatureOf } from '@/lib/server-runs/query-plan'
import {
  buildSummary,
  checkPushdown,
  entryResult,
  runAllChecks,
  type DqCheck,
  type DqCheckResult,
  type DqReport,
  type DqRunEntry,
} from '@/lib/duckdb/data-quality'

export type DqRunKind = 'dq_rule_set' | 'dq_profile'

/** Where a server run is, as its checkpoint says. */
export interface DqRunState {
  next?: number
  total?: number
  current?: { key: string; what: string }
  /** What it kept of each check done, by `dqRunKey`. */
  results?: Record<string, DqRunEntry>
  meta?: { signature?: string }
  startedAt?: string
}

const dqRunKey = (index: number) => `c${index}`

/** What a run checks: a paused run of other checks resumes as it started. */
export function dqRunSignature(checks: readonly DqCheck[]): string {
  return signatureOf(checks.flatMap((c) => [c.id, c.sql, String(c.threshold), c.severity, c.category]))
}

/** The server run's spec (apps/api schemas/dq_run.py): each check as its report
 *  keeps it, and its SQL as the database runs it. */
export async function compileDqRun(dataSourceId: string, checks: DqCheck[], label: string) {
  const plan = await preparePlan(dataSourceId, {
    label,
    items: checks.map((c, i) => ({ key: dqRunKey(i), sql: c.sql, what: localized(c.name, i18n.language) })),
  })
  return {
    label,
    dataSourceId,
    checks,
    keepGoing: true,
    meta: { signature: dqRunSignature(checks) },
    items: plan.items.map((item, i) => ({ ...item, pushdown: checkPushdown(checks[i]) })),
  }
}

/** A server run's report so far: the checks it has done, for the checks it was
 *  compiled from (`dqRunSignature` says they are these). */
export function dqRunReport(dataSourceId: string, checks: DqCheck[], state: DqRunState, computedAt: string): DqReport {
  const done: DqCheck[] = []
  const results: DqCheckResult[] = []
  checks.forEach((check, i) => {
    const entry = state.results?.[dqRunKey(i)]
    if (!entry) return
    done.push(check)
    results.push(entryResult(check, entry))
  })
  return { dataSourceId, computedAt, checks: done, results, summary: buildSummary(done, results) }
}

/** The time the checks left took in an earlier report, when it timed most of them. */
export function dqRunEta(checks: DqCheck[], state: DqRunState, previous: DqReport | null): number | null {
  if (!previous) return null
  const took = new Map(previous.results.map((r) => [r.checkId, r.executionTimeMs]))
  const left = checks.slice(state.next ?? 0)
  if (!left.length) return null
  const known = left.filter((c) => took.has(c.id))
  if (known.length < left.length / 2) return null
  const ms = known.reduce((sum, c) => sum + took.get(c.id)!, 0)
  return (ms / known.length) * left.length
}

// --- front-only mode -------------------------------------------------------

export interface DqRunSnapshot extends RunSnapshotBase {
  done: number
  total: number
}

export interface DqRunInput {
  /** The rule set's or the profile's id. */
  runKey: string
  dataSourceId: string
  checks: DqCheck[]
  /** Before the first check (mount the database). */
  prepare: () => Promise<void>
  /** The finished report, recorded wherever the page records it. */
  onComplete: (report: DqReport) => void
}

const IDLE: DqRunSnapshot = { running: false, error: null, done: 0, total: 0 }

/** The last report of each run, for a view that mounts after it ended. */
const reports = new Map<string, DqReport>()
export const lastDqReport = (runKey: string) => reports.get(runKey) ?? null

async function execute(input: DqRunInput, signal: AbortSignal, emit: (patch: Partial<DqRunSnapshot>, immediate?: boolean) => void): Promise<void> {
  const { runKey, dataSourceId, checks } = input
  emit({ done: 0, total: checks.length }, true)
  await input.prepare()
  signal.throwIfAborted()
  const report = await runAllChecks(dataSourceId, checks, (done) => emit({ done }))
  reports.set(runKey, report)
  input.onComplete(report)
}

const registry = createRunRegistry<DqRunInput, DqRunSnapshot>({ idle: IDLE, execute })

export const getDqRun = registry.get
export const watchDqRun = registry.watch
export const stopDqRun = registry.pause
export const clearDqRunError = registry.clearError

export function startDqRun(input: DqRunInput): void {
  registry.clearError(input.runKey)
  reports.delete(input.runKey)
  registry.start(input.runKey, input)
}
