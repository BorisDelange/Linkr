import { ApiError } from '@/lib/api-client'

/** The details the server answers a stopped query with (core/deferred.py):
 *  stopped by its client, or from the jobs panel. */
const STOPPED_DETAILS = new Set(['query cancelled', 'cancelled from the jobs panel'])

/** Whether `err` says the query was stopped — by its caller, from the jobs
 *  panel, or by the deferred poll — rather than that it failed. */
export function isQueryStopped(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (!(err instanceof ApiError)) return false
  if (err.status === 499) return true
  if (err.status !== 409) return false
  try {
    return STOPPED_DETAILS.has(JSON.parse(err.message)?.detail)
  } catch {
    return STOPPED_DETAILS.has(err.message)
  }
}
