import { apiRequest } from '@/lib/api-client'
import * as duckdbEngine from '@/lib/duckdb/engine'
import {
  ACTIVE_RUN_STATUSES,
  cancelServerRun,
  getLatestServerRun,
  startServerRun,
  type ServerRun,
  type ServerRunKind,
} from '@/lib/api/server-runs'

/**
 * Queries that do not depend on each other, compiled once by the page: in server
 * mode a `query_list` run (apps/api services/server_runs/query_list.py) runs them,
 * page open or not; in client-only mode the page runs the same SQL itself. Either
 * way the page assembles what they returned — one compile, one assemble.
 */
export interface QueryPlanItem {
  /** Names its result: letters, digits, `_`, `-`, `.`. */
  key: string
  sql: string
  /** What it computes, for the job's input and log. */
  what?: string
}

export interface QueryPlan {
  label: string
  items: QueryPlanItem[]
  /** A query that fails is recorded and the others still run. */
  keepGoing?: boolean
  /** The page's own, carried into the run's state (a fingerprint, a definition). */
  meta?: Record<string, unknown>
}

/** Where a `query_list` run is, as its checkpoint says. */
export interface QueryListState {
  next?: number
  total?: number
  /** Rows per key of the queries done, and the error of each that failed. */
  rows?: Record<string, number>
  errors?: Record<string, string>
  current?: { key: string; what: string }
  meta?: Record<string, unknown>
}

/** Each query's rows, or its error; a key absent was not run. */
export type PlanResults = Map<string, Record<string, unknown>[] | Error>

/** Every SQL as the database will run it: class relations injected, as `queryDataSource` does. */
export async function preparePlan(dataSourceId: string, plan: QueryPlan): Promise<QueryPlan> {
  const items = await Promise.all(plan.items.map(async (item) => ({
    ...item, sql: await duckdbEngine.prepareQuerySql(dataSourceId, item.sql),
  })))
  return { ...plan, items }
}

/** Client-only mode: the plan, run here one query after the other. */
export async function runPlanLocally(dataSourceId: string, plan: QueryPlan, origin: string): Promise<PlanResults> {
  const out: PlanResults = new Map()
  for (const item of plan.items) {
    try {
      out.set(item.key, await duckdbEngine.queryDataSource(dataSourceId, item.sql, { allRows: true, heavy: true, origin }))
    } catch (err) {
      if (!plan.keepGoing) throw err
      out.set(item.key, err instanceof Error ? err : new Error(String(err)))
    }
  }
  return out
}

/** A finished run's results, read from the server: the rows it kept, the errors it recorded. */
export async function runResults(runId: string, state: QueryListState, keys: readonly string[]): Promise<PlanResults> {
  const out: PlanResults = new Map()
  await Promise.all(keys.map(async (key) => {
    const error = state.errors?.[key]
    if (error) {
      out.set(key, new Error(error))
      return
    }
    if (state.rows?.[key] === undefined) return
    const { rows } = await apiRequest<{ rows: Record<string, unknown>[] }>(
      `/server-runs/${encodeURIComponent(runId)}/results/${encodeURIComponent(key)}`,
    )
    out.set(key, rows)
  }))
  return out
}

/** A short fingerprint of what a plan computes (`meta.signature`), to tell its
 *  run from one of another definition under the same scope. */
export function signatureOf(parts: readonly string[]): string {
  let h = 5381
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) h = ((h << 5) + h + part.charCodeAt(i)) | 0
    h = ((h << 5) + h + 0x1f) | 0
  }
  return (h >>> 0).toString(36)
}

/** How often a followed run is read again. */
const FOLLOW_MS = 1000
/** How often a cancelled run is read again until it has stopped. */
const STOPPING_MS = 200

/** A run of another definition gives way: cancelled, then this plan's started once it has stopped. */
async function replace<S>(kind: ServerRunKind, scopeId: string, run: ServerRun<S>, plan: QueryPlan, signal?: AbortSignal) {
  await cancelServerRun(run.id)
  for (;;) {
    const latest = await getLatestServerRun<S>(kind, scopeId)
    if (!latest || !ACTIVE_RUN_STATUSES.includes(latest.status)) break
    signal?.throwIfAborted()
    await new Promise((resolve) => setTimeout(resolve, STOPPING_MS))
  }
  return startServerRun<S>(kind, scopeId, plan)
}

/**
 * A plan run on the server, followed from here: started — or the run already
 * going on for this kind and scope joined, as after a reload — and each query's
 * rows handed to `onRows` as they land, in no particular order. `resumeOnly`:
 * only join one going on — or, with `finished`, one done meanwhile; null when
 * there is none. A plan signed (`meta.signature`) joins only a run of the same
 * signature: one of another definition is replaced, or not joined. A stop from
 * here (`signal`) cancels the run.
 */
export async function followServerPlan(
  kind: ServerRunKind,
  scopeId: string,
  plan: QueryPlan,
  onRows: (index: number, rows: Record<string, unknown>[] | null, error?: string) => void,
  { signal, resumeOnly = false, finished = false }: { signal?: AbortSignal; resumeOnly?: boolean; finished?: boolean } = {},
): Promise<ServerRun<QueryListState> | null> {
  let run = resumeOnly
    ? await getLatestServerRun<QueryListState>(kind, scopeId)
    : await startServerRun<QueryListState>(kind, scopeId, plan)
  if (!run) return null
  // `finished`: a run that ended while no page followed it is taken up too.
  if (resumeOnly && !ACTIVE_RUN_STATUSES.includes(run.status) && !(finished && run.status === 'done')) return null
  const signature = plan.meta?.signature
  if (signature !== undefined && run.state.meta?.signature !== signature) {
    if (resumeOnly) return null
    run = await replace(kind, scopeId, run, plan, signal)
  }
  const index = new Map(plan.items.map((item, i) => [item.key, i]))
  const delivered = new Set<string>()
  const stop = () => { if (run) void cancelServerRun(run.id).catch(() => {}) }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    for (;;) {
      const state = run.state
      for (const [key, i] of index) {
        if (delivered.has(key)) continue
        const error = state.errors?.[key]
        if (error !== undefined) {
          delivered.add(key)
          onRows(i, null, error)
        } else if (state.rows?.[key] !== undefined) {
          delivered.add(key)
          const { rows } = await apiRequest<{ rows: Record<string, unknown>[] }>(
            `/server-runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(key)}`,
          )
          onRows(i, rows)
        }
      }
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) return run
      signal?.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_MS))
      signal?.throwIfAborted()
      const next = await getLatestServerRun<QueryListState>(kind, scopeId)
      if (!next || next.id !== run.id) return run
      run = next
    }
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}
