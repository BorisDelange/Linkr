import { apiRequest } from '@/lib/api-client'

/** What a server run computes (apps/api services/server_runs/registry.py). */
export type ServerRunKind = 'stats' | 'extraction' | 'etl' | 'etl_quality' | 'database_stats' | 'cohort_run' | 'cohort_figures' | 'catalog' | 'catalog_estimate' | 'catalog_audit' | 'dq_rule_set' | 'dq_profile'
export type ServerRunStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'interrupted' | 'done' | 'failed' | 'cancelled'

export const ACTIVE_RUN_STATUSES: readonly ServerRunStatus[] = ['queued', 'running', 'pausing']
export const RESUMABLE_RUN_STATUSES: readonly ServerRunStatus[] = ['paused', 'interrupted', 'failed']

/** A long computation the server runs; `state` is its kind's checkpoint. */
export interface ServerRun<S = Record<string, unknown>> {
  id: string
  dataSourceId: string | null
  kind: ServerRunKind
  scopeId: string
  status: ServerRunStatus
  requested: string | null
  state: S
  error: string | null
  jobId: string | null
  attempt: number
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

/** The run going on for this kind and scope, else the last one; null when none ran. */
export function getLatestServerRun<S>(kind: ServerRunKind, scopeId: string): Promise<ServerRun<S> | null> {
  const params = new URLSearchParams({ kind, scopeId })
  return apiRequest<ServerRun<S> | null>(`/server-runs/latest?${params}`)
}

/** Start a run, or get the one already going on for this kind and scope. */
export function startServerRun<S>(kind: ServerRunKind, scopeId: string, spec: unknown): Promise<ServerRun<S>> {
  return apiRequest<ServerRun<S>>('/server-runs', { method: 'POST', body: JSON.stringify({ kind, scopeId, spec }) })
}

export function pauseServerRun<S>(runId: string): Promise<ServerRun<S>> {
  return apiRequest<ServerRun<S>>(`/server-runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' })
}

/** Stop it for good. */
export function cancelServerRun<S>(runId: string): Promise<ServerRun<S>> {
  return apiRequest<ServerRun<S>>(`/server-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}

/** Go on where it stopped; `spec`, compiled again, for a kind that takes one. */
export function resumeServerRun<S>(runId: string, spec?: unknown): Promise<ServerRun<S>> {
  return apiRequest<ServerRun<S>>(`/server-runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    ...(spec === undefined ? {} : { body: JSON.stringify({ spec }) }),
  })
}

/** A result file the run kept (`results/<key>.json`), as the server stored it. */
export async function getServerRunResult<T>(runId: string, key: string): Promise<T> {
  const { rows } = await apiRequest<{ rows: T }>(`/server-runs/${encodeURIComponent(runId)}/results/${encodeURIComponent(key)}`)
  return rows
}
