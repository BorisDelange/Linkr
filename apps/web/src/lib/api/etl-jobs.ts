/**
 * Run one ETL script on its target as a server job (backend
 * `services/data/etl_jobs.py`): the script is sent whole, so one DuckDB session
 * carries it (`SET VARIABLE`, temp tables), and the client only polls — no
 * request, nor socket, stays open while a statement runs, so a gateway's
 * timeout cannot cut the run. Closing the tab does not stop it; the jobs panel
 * does.
 */

import { apiRequest } from '@/lib/api-client'
import { cancelJob, type Job } from './environments'
import { getJob, queryJobRows } from './query-jobs'

/** Called before each statement, as the job reports it. */
export type EtlStatementProgress = (index: number, total: number, sql: string) => void

interface EtlJobProgress {
  sourceId: string
  index: number
  total: number
  sql: string
  /** Percent of its data the statement in flight has read, when DuckDB can tell. */
  reading?: number | null
  done?: string[]
  error?: string
}

const POLL_MS = 1000

/** Thrown when the job was cancelled — from the jobs panel or by `signal`. */
export class EtlJobCancelledError extends Error {
  constructor() {
    super('The run was stopped')
    this.name = 'EtlJobCancelledError'
  }
}

export async function runEtlJob(
  targetId: string,
  label: string,
  sql: string,
  roles: Record<string, string>,
  mappingData: Record<string, string> = {},
  options: { onStatement?: EtlStatementProgress; onReading?: (pct: number | null) => void; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const { onStatement, onReading, signal } = options
  if (signal?.aborted) throw new EtlJobCancelledError()
  const job = await apiRequest<Job>(`/data-sources/${targetId}/etl-jobs`, {
    method: 'POST',
    body: JSON.stringify({ label, sql, roles, mappingData }),
  })
  let seen = -1
  try {
    for (;;) {
      signal?.throwIfAborted()
      const current = await getJob(job.id)
      const progress = current.result as EtlJobProgress | null | undefined
      if (progress && progress.total > 0 && progress.index !== seen) {
        seen = progress.index
        onStatement?.(progress.index, progress.total, progress.sql)
      }
      onReading?.(progress?.reading ?? null)
      if (current.status === 'done') return queryJobRows(targetId, job.id, 'rows')
      if (current.status === 'cancelled') throw new EtlJobCancelledError()
      if (current.status === 'error') throw new Error(progress?.error ?? (current.logTail.trim() || 'the ETL run failed'))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, POLL_MS)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
    }
  } catch (err) {
    if (signal?.aborted) {
      await cancelJob(job.id).catch(() => {})
      throw new EtlJobCancelledError()
    }
    throw err
  }
}
