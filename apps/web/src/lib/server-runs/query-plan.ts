import { apiRequest } from '@/lib/api-client'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { sha256Hex } from '@/lib/sha256'
import {
  ACTIVE_RUN_STATUSES,
  cancelServerRun,
  getLatestServerRun,
  startServerRun,
  type ServerRun,
  type ServerRunKind,
} from '@/lib/api/server-runs'
import { retrying, sleep } from './retry'

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
  /** The page's own, carried into the run's state (a fingerprint, a definition).
   *  `signatureBasis`: what the plan's signature covers beyond its database and
   *  queries (`planSignature`); `signature`: the one this page expects, which
   *  the server does not take from it. */
  meta?: { signatureBasis?: string[]; signature?: string; [key: string]: unknown }
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

const readResult = (runId: string, key: string, signal?: AbortSignal) => retrying(() => apiRequest<{ rows: Record<string, unknown>[] }>(
  `/server-runs/${encodeURIComponent(runId)}/results/${encodeURIComponent(key)}`,
), signal)

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
    const { rows } = await readResult(runId, key)
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

/**
 * What a run of `plan` on `dataSourceId` reads, as the server computes it at the
 * run's start (`ServerRun.signature`, apps/api services/server_runs/query_list.py
 * `signature`): SHA-256, in hex, over netstrings (`<utf-8 byte length>:<bytes>,`)
 * of the database, the count and parts of `meta.signatureBasis`, then the count of
 * the items and each one's key and SQL, in order. Pinned on both sides by
 * `__fixtures__/server-runs/plan-signature.json`.
 */
export async function planSignature(dataSourceId: string, plan: QueryPlan): Promise<string> {
  const basis = plan.meta?.signatureBasis ?? []
  const parts = [dataSourceId, String(basis.length), ...basis, String(plan.items.length), ...plan.items.flatMap((item) => [item.key, item.sql])]
  const encoder = new TextEncoder()
  const chunks = parts.flatMap((part) => {
    const bytes = encoder.encode(part)
    return [encoder.encode(`${bytes.length}:`), bytes, encoder.encode(',')]
  })
  const canonical = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    canonical.set(chunk, at)
    at += chunk.length
  }
  return sha256Hex(canonical)
}

/** The plan signed by what it reads (`planSignature`): a run of other queries, of
 *  the same ones in another order or on another database, is not taken for its own. */
export async function signedPlan(dataSourceId: string, plan: QueryPlan): Promise<QueryPlan> {
  return { ...plan, meta: { ...plan.meta, signature: await planSignature(dataSourceId, plan) } }
}

/** How often a followed run is read again. */
const FOLLOW_MS = 1000
/** How often a cancelled run is read again until it has stopped. */
const STOPPING_MS = 200

const scopeKey = (kind: ServerRunKind, scopeId: string) => `${kind}|${scopeId}`
/** The cancel each scope's last stopped follow asked for, until the server has it:
 *  a plan started again at once (a re-run) waits for it, and then finds the
 *  run being stopped, rather than join it as it goes. */
const stopping = new Map<string, Promise<void>>()

/** Asked to stop: it ends cancelled (or paused), whatever its signature. */
const beingStopped = (run: ServerRun<unknown>) => run.status === 'pausing' || run.requested === 'cancel'

/** The run here gives way: cancelled, then this plan's started once it has stopped. */
async function replace<S>(kind: ServerRunKind, scopeId: string, run: ServerRun<S>, plan: QueryPlan, signal?: AbortSignal) {
  await cancelServerRun(run.id)
  for (;;) {
    const latest = await retrying(() => getLatestServerRun<S>(kind, scopeId), signal)
    if (!latest || !ACTIVE_RUN_STATUSES.includes(latest.status)) break
    signal?.throwIfAborted()
    await sleep(STOPPING_MS, signal)
  }
  signal?.throwIfAborted()
  return startServerRun<S>(kind, scopeId, plan)
}

/**
 * A plan run on the server, followed from here: started — or the run already
 * going on for this kind and scope joined, as after a reload — and each query's
 * rows handed to `onRows` as they land, in no particular order. `resumeOnly`:
 * only join one going on — or, with `finished`, one done meanwhile; null when
 * there is none. A plan signed (`signedPlan`) joins only a run the server signed
 * the same: one of another definition — or one being stopped — is replaced,
 * or not joined. A stop from here (`signal`) cancels the run.
 */
export async function followServerPlan(
  kind: ServerRunKind,
  scopeId: string,
  plan: QueryPlan,
  onRows: (index: number, rows: Record<string, unknown>[] | null, error?: string) => void,
  { signal, resumeOnly = false, finished = false, onRun }: {
    signal?: AbortSignal; resumeOnly?: boolean; finished?: boolean
    /** The run followed, once known — before any of its rows. */
    onRun?: (run: ServerRun<QueryListState>) => void
  } = {},
): Promise<ServerRun<QueryListState> | null> {
  const key = scopeKey(kind, scopeId)
  const signature = plan.meta?.signature
  const ours = (r: ServerRun<QueryListState>) => signature === undefined || r.signature === signature

  let run: ServerRun<QueryListState> | null = null
  // Stopped before its run was known: the stop is held until it is, or none comes.
  let release: (() => void) | undefined
  const hold = (promise: Promise<void>) => {
    stopping.set(key, promise)
    void promise.then(() => { if (stopping.get(key) === promise) stopping.delete(key) })
  }
  const cancel = (target: ServerRun<QueryListState>) => {
    hold(cancelServerRun(target.id).then(() => {}, () => {}))
    release?.()
  }
  const onAbort = () => {
    if (run) cancel(run)
    else hold(new Promise<void>((resolve) => { release = resolve }))
  }
  // The run followed from now on; one taken up after the stop is stopped at once.
  const follow = (next: ServerRun<QueryListState>) => {
    run = next
    if (signal?.aborted) {
      cancel(next)
      signal.throwIfAborted()
    }
    return next
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let current: ServerRun<QueryListState>
    if (resumeOnly) {
      const latest = await retrying(() => getLatestServerRun<QueryListState>(kind, scopeId), signal)
      if (!latest) return null
      // `finished`: a run that ended while no page followed it is taken up too.
      if (!ACTIVE_RUN_STATUSES.includes(latest.status) && !(finished && latest.status === 'done')) return null
      if (!ours(latest)) return null
      current = follow(latest)
    } else {
      while (stopping.has(key)) await stopping.get(key)
      signal?.throwIfAborted()
      current = follow(await startServerRun<QueryListState>(kind, scopeId, plan))
      if (!ours(current) || (ACTIVE_RUN_STATUSES.includes(current.status) && beingStopped(current))) {
        current = follow(await replace(kind, scopeId, current, plan, signal))
      }
    }
    onRun?.(current)
    const index = new Map(plan.items.map((item, i) => [item.key, i]))
    const delivered = new Set<string>()
    for (;;) {
      const state = current.state
      for (const [k, i] of index) {
        if (delivered.has(k)) continue
        const error = state.errors?.[k]
        if (error !== undefined) {
          delivered.add(k)
          onRows(i, null, error)
        } else if (state.rows?.[k] !== undefined) {
          delivered.add(k)
          const { rows } = await readResult(current.id, k, signal)
          onRows(i, rows)
        }
      }
      if (!ACTIVE_RUN_STATUSES.includes(current.status)) return current
      signal?.throwIfAborted()
      await sleep(FOLLOW_MS, signal)
      const next = await retrying(() => getLatestServerRun<QueryListState>(kind, scopeId), signal)
      if (!next) return { ...current, status: 'cancelled', finishedAt: new Date().toISOString() }
      if (next.id !== current.id) {
        // Another run took its place (another tab, the MCP): ours has ended.
        // One of the same definition computes the same, and is followed from its start.
        if (!ours(next)) return { ...current, status: 'cancelled', error: 'replaced by another run', finishedAt: next.createdAt }
        delivered.clear()
      }
      current = follow(next)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    release?.()
  }
}
