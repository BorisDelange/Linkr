/**
 * Query jobs: read queries the server runs one after the other as a job
 * (backend `services/data/query_jobs.py`), for work too long for one request
 * through a gateway. The client only makes short requests: start, poll, fetch
 * each result once the job lists it done.
 */

import { apiRequest } from '@/lib/api-client'
import { cancelJob, type Job } from './environments'

/** What a query job reports on its row; the rows themselves are fetched by key. */
interface QueryJobProgress {
  sourceId: string
  done: string[]
  rows: Record<string, number>
  total: number
  /** Why the query that stopped the job failed, in full. */
  error?: string
}

export interface QueryJobItem {
  key: string
  sql: string
}

const POLL_MS = 1500

export function startQueryJob(dataSourceId: string, label: string, queries: readonly QueryJobItem[], pushdown = true): Promise<Job> {
  return apiRequest<Job>(`/data-sources/${dataSourceId}/query-jobs`, {
    method: 'POST',
    body: JSON.stringify({ label, queries, pushdown }),
  })
}

export function getJob(jobId: string): Promise<Job> {
  return apiRequest<Job>(`/jobs/${encodeURIComponent(jobId)}`)
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

/**
 * Follow a job, handing each finished query's rows over in `keys` order, until
 * every key is delivered or the job ends. Answers how it ended: the caller
 * decides what an unfinished end means. Aborting `signal` cancels the job.
 */
export async function followQueryJob(
  dataSourceId: string,
  jobId: string,
  keys: readonly string[],
  onRows: (index: number, rows: Record<string, unknown>[]) => Promise<void>,
  { signal, onWaiting }: { signal: AbortSignal; onWaiting?: (index: number) => void },
): Promise<QueryJobOutcome> {
  let delivered = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const job = await getJob(jobId)
      const progress = job.result as QueryJobProgress | null | undefined
      const done = new Set(progress?.done ?? [])
      while (delivered < keys.length && done.has(keys[delivered])) {
        signal.throwIfAborted()
        await onRows(delivered, await queryJobRows(dataSourceId, jobId, keys[delivered]))
        delivered++
      }
      if (delivered === keys.length) return { status: job.status, delivered, error: null }
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        return { status: job.status, delivered, error: progress?.error ?? (job.logTail.trim() || null) }
      }
      onWaiting?.(delivered)
      await sleep(POLL_MS, signal)
    }
  } catch (err) {
    if (signal.aborted) await cancelJob(jobId).catch(() => {})
    throw err
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
