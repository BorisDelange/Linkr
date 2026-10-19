/**
 * Query jobs: read queries the server runs one after the other as a job
 * (backend `services/data/query_jobs.py`), for work too long for one request
 * through a gateway. The client only makes short requests: start, poll, fetch
 * each result once the job lists it done.
 */

import { ApiError, apiRequest } from '@/lib/api-client'
import { cancelJob, type Job } from './environments'

/** What a query job reports on its row; the rows themselves are fetched by key. */
interface QueryJobProgress {
  sourceId: string
  done: string[]
  rows: Record<string, number>
  /** How long each query done took, server side. */
  ms?: Record<string, number>
  /** A keep-going job's failed queries: done, without rows. */
  errors?: Record<string, string>
  total: number
  /** The query in flight, and the percent of its data read — set only while
   *  the database can tell (server DuckDB; not a pushed-down external query). */
  current?: string
  reading?: number
  /** Why the query that stopped the job failed, in full. */
  error?: string
}

export interface QueryJobItem {
  key: string
  sql: string
  /** This query's own pushdown, over the job's: the app's own SQL only. */
  pushdown?: boolean
}

const POLL_MS = 1500
/** Waits between retries of a poll the network or the gateway failed: about a
 *  minute in all, the time a proxy restart or a dropped connection takes. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000]

/** `keepGoing`: a failing query does not end the job; its error comes with its key. */
export function startQueryJob(
  dataSourceId: string,
  label: string,
  queries: readonly QueryJobItem[],
  { pushdown = true, keepGoing = false }: { pushdown?: boolean; keepGoing?: boolean } = {},
): Promise<Job> {
  return apiRequest<Job>(`/data-sources/${dataSourceId}/query-jobs`, {
    method: 'POST',
    body: JSON.stringify({ label, queries, pushdown, keepGoing }),
  })
}

/** `withInput`: also what the job runs (up to 200 KB) — for the panel's Input tab, not a poll. */
export function getJob(jobId: string, { withInput = false }: { withInput?: boolean } = {}): Promise<Job> {
  return apiRequest<Job>(`/jobs/${encodeURIComponent(jobId)}${withInput ? '?withInput=true' : ''}`)
}

export async function queryJobRows(dataSourceId: string, jobId: string, key: string): Promise<Record<string, unknown>[]> {
  const res = await apiRequest<{ rows: Record<string, unknown>[] }>(
    `/data-sources/${dataSourceId}/query-jobs/${encodeURIComponent(jobId)}/results/${encodeURIComponent(key)}`,
  )
  return res.rows
}

export interface QueryJobOutcome {
  status: Job['status']
  /** How many of the keys were handed over, from the first. */
  delivered: number
  /** Why the job ended without finishing. */
  error: string | null
}

/** What a finished query hands over besides its rows. */
export interface QueryJobDone {
  /** Server-side time it took, when the job reports it. */
  ms: number | null
  /** Why it failed, in a keep-going job (its rows are then empty). */
  error: string | null
}

export interface FollowOptions {
  signal: AbortSignal
  /** The query at `index` is still running; `reading` is the percent of its
   *  data read, null when the database cannot tell. */
  onWaiting?: (index: number, reading: number | null) => void
  /** False for a job whose queries keep their result on the server (concept
   *  units): each is handed over done, with no rows. */
  fetchRows?: boolean
}

/**
 * Follow a job, handing each finished query's rows over in `keys` order, until
 * every key is delivered or the job ends. Answers how it ended: the caller
 * decides what an unfinished end means. Aborting `signal` cancels the job.
 */
export async function followQueryJob(
  dataSourceId: string,
  jobId: string,
  keys: readonly string[],
  onRows: (index: number, rows: Record<string, unknown>[], done: QueryJobDone) => Promise<void>,
  { signal, onWaiting, fetchRows = true }: FollowOptions,
): Promise<QueryJobOutcome> {
  let delivered = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const job = await retrying(() => getJob(jobId), signal)
      const progress = job.result as QueryJobProgress | null | undefined
      const done = new Set(progress?.done ?? [])
      while (delivered < keys.length && done.has(keys[delivered])) {
        signal.throwIfAborted()
        const key = keys[delivered]
        const error = progress?.errors?.[key] ?? null
        const rows = fetchRows && error == null ? await retrying(() => queryJobRows(dataSourceId, jobId, key), signal) : []
        await onRows(delivered, rows, { ms: progress?.ms?.[key] ?? null, error })
        delivered++
      }
      if (delivered === keys.length) return { status: job.status, delivered, error: null }
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        return { status: job.status, delivered, error: progress?.error ?? (job.logTail.trim() || null) }
      }
      onWaiting?.(delivered, progress?.current === keys[delivered] ? progress.reading ?? null : null)
      await sleep(POLL_MS, signal)
    }
  } catch (err) {
    if (signal.aborted) await cancelJob(jobId).catch(() => {})
    throw err
  }
}

/** The job is no more on the server: cleared from the panel, or lost with its results. */
export const isJobGone = (err: unknown) => err instanceof ApiError && err.status === 404

/** A failure that says nothing of the job: the request did not reach the API. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 502 || err.status === 503 || err.status === 504
  // fetch rejects with a TypeError when the network fails.
  return err instanceof TypeError
}

async function retrying<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (err) {
      if (signal.aborted || attempt >= RETRY_MS.length || !isTransient(err)) throw err
      await sleep(RETRY_MS[attempt], signal)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
