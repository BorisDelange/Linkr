/**
 * App queries run as one server query job (`lib/api/query-jobs.ts`), each
 * result handed over in order — for work too long for one request through a
 * gateway: a rule set's checks, a database's statistics. The catalog, which
 * resumes phase by phase, has its own executor (`catalog-job-executor.ts`).
 *
 * A job can be remembered in this browser under a name: a page opened again
 * after its tab was closed then follows the job rather than lose the run.
 */

import { cancelJob } from '@/lib/api/environments'
import { followQueryJob, isJobGone, isTransient, startQueryJob, type QueryJobDone, type QueryJobItem, type QueryJobOutcome } from '@/lib/api/query-jobs'
import { prepareQuerySql } from './engine'

/** Where a job is remembered, and what it was started for: a job started for
 *  other queries (the checks were edited since) is not followed. */
export interface RememberedJob {
  name: string
  signature: string
}

interface StoredJob {
  jobId: string
  signature: string
}

const storageKey = (name: string) => `linkr:query-job:${name}`

function readJob(name: string): StoredJob | null {
  try {
    const raw = localStorage.getItem(storageKey(name))
    return raw ? (JSON.parse(raw) as StoredJob) : null
  } catch {
    return null
  }
}

function writeJob(name: string, job: StoredJob | null): void {
  try {
    if (job) localStorage.setItem(storageKey(name), JSON.stringify(job))
    else localStorage.removeItem(storageKey(name))
  } catch { /* private window: the run is not followed after a reload, that is all */ }
}

/** Whether a job is remembered under `name` (whatever it was started for). */
export const hasRememberedJob = (name: string) => readJob(name) != null

export interface RunQueryJobOptions {
  signal: AbortSignal
  /** A failing query does not end the job: it comes with its error. */
  keepGoing?: boolean
  /** Remember the job under this name, and follow the one remembered there if it was started for the same queries. */
  remember?: RememberedJob
  /** Only follow a remembered job: answers null, starting nothing, when there is none (or it is gone). */
  resumeOnly?: boolean
  /** The query at `index` is running; `reading` is the percent of its data read, when known. */
  onWaiting?: (index: number, reading: number | null) => void
}

/** Answers how the job ended, or null for a `resumeOnly` run with nothing to follow. Aborting `signal` cancels the job. */
export async function runQueryJob(
  dataSourceId: string,
  label: string,
  queries: readonly QueryJobItem[],
  onResult: (index: number, rows: Record<string, unknown>[], done: QueryJobDone) => Promise<void> | void,
  { signal, keepGoing = false, remember, resumeOnly = false, onWaiting }: RunQueryJobOptions,
): Promise<QueryJobOutcome | null> {
  const keys = queries.map((q) => q.key)
  // A TypeError from the caller's own handler is no network failure.
  let handlerFailed = false
  const follow = (jobId: string) => followQueryJob(dataSourceId, jobId, keys, async (i, rows, done) => {
    try {
      await onResult(i, rows, done)
    } catch (err) {
      handlerFailed = true
      throw err
    }
  }, { signal, onWaiting })
  const stillRunning = (err: unknown) => !handlerFailed && isTransient(err)

  const stored = remember ? readJob(remember.name) : null
  // The job being followed, kept remembered only when following it failed on
  // the way (network, gateway): it runs on, and the next run picks it up. Any
  // other failure (a refusal, the caller's handler) would leave it remembered
  // for good, every `resumeOnly` run answering null.
  let following: string | null = null
  let keep = false
  try {
    if (stored && stored.signature === remember!.signature) {
      try {
        following = stored.jobId
        return await follow(stored.jobId)
      } catch (err) {
        if (signal.aborted) throw err
        if (resumeOnly) {
          keep = stillRunning(err)
          return null
        }
        // Not gone, yet not followed: a second job must not wait behind it in the lane.
        if (!isJobGone(err)) await cancelJob(stored.jobId).catch(() => {})
      }
    } else if (stored) {
      // Started for other queries (edited since): nobody will read its results.
      await cancelJob(stored.jobId).catch(() => {})
    }
    following = null
    if (resumeOnly) return null
    const items = await Promise.all(queries.map(async (q) => ({ ...q, sql: await prepareQuerySql(dataSourceId, q.sql) })))
    signal.throwIfAborted()
    const job = await startQueryJob(dataSourceId, label, items, { keepGoing })
    if (remember) writeJob(remember.name, { jobId: job.id, signature: remember.signature })
    following = job.id
    return await follow(job.id)
  } catch (err) {
    keep = following != null && !signal.aborted && stillRunning(err)
    if (resumeOnly && !signal.aborted) return null
    throw err
  } finally {
    if (remember && !keep) writeJob(remember.name, null)
  }
}
