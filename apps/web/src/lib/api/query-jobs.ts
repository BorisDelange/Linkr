/**
 * Server jobs as the page reads them: a job's row, and the rows a query job
 * (backend `services/data/query_jobs.py`) kept for one of its keys.
 */

import { apiRequest } from '@/lib/api-client'
import type { Job } from './environments'

/** `withInput`: also what the job runs (up to 200 KB) — for the panel's Input tab, not a poll. */
export function getJob(jobId: string, { withInput = false }: { withInput?: boolean } = {}): Promise<Job> {
  return apiRequest<Job>(`/jobs/${encodeURIComponent(jobId)}${withInput ? '?withInput=true' : ''}`)
}

export async function queryJobRows(dataSourceId: string, jobId: string, key: string): Promise<Record<string, unknown>[]> {
  const res = await apiRequest<{ rows: Record<string, unknown>[] }>(
    `/data-sources/${encodeURIComponent(dataSourceId)}/query-jobs/${encodeURIComponent(jobId)}/results/${encodeURIComponent(key)}`,
  )
  return res.rows
}
