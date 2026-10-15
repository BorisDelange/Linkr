/**
 * One catalog computation, start to finish or up to a pause, with no view and
 * no registry: the app's runner (`catalog-runner.ts`) drives it for a tab that
 * may come and go, the MCP server for a tool call with a time budget. It takes
 * an already-routed query and imports nothing that needs a browser.
 *
 * The unit of progress is one query (see `catalog-compute.ts`); the cache
 * written at each save point holds exactly the units before its offset, so a
 * resume from it picks up at the next one.
 */

import type { CatalogResultCache, DataCatalog } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import { effectiveCrossings } from '@/lib/data-catalog/config'
import {
  baseUnits,
  cacheFromState,
  emptyRunState,
  orderModalities,
  planCrossings,
  planSlices,
  stateFromCache,
  type CatalogQuery,
  type CatalogRunState,
  type CatalogRunStep,
  type CatalogRunUnit,
  type CatalogUnitInfo,
  type CrossingPlan,
} from './catalog-compute'

/** One unit's query, by the unit's position in the run. */
export interface CatalogPhaseQuery {
  offset: number
  sql: string
}

export type CatalogPhase = 'base' | 'crossings'

/**
 * Runs one phase's queries in order and hands each result over as it lands.
 * Without one, the run sends them one by one through `query`; the app in server
 * mode hands the whole phase to a server job (`catalog-job-executor.ts`), which
 * outlives the tab and no gateway timeout can cut.
 */
export type CatalogPhaseExecutor = (phase: {
  name: CatalogPhase
  queries: readonly CatalogPhaseQuery[]
  /** The job a paused run left this phase to: follow it rather than start over. */
  resumeJob: string | null
  /** A job now carries the phase: saved at once, so a tab closed before its first
   *  result still resumes by following it. */
  jobStarted: (jobId: string) => Promise<void>
  /** The query at `offset` is the one being worked on, for the progress line;
   *  `reading`, the percent of its data read when the database can tell. */
  starting: (offset: number, reading?: number | null) => void
  onRows: (offset: number, rows: Record<string, unknown>[]) => Promise<void>
  signal: AbortSignal
}) => Promise<void>

/** The phase was cancelled from outside the run (the jobs panel): a pause. */
export class CatalogPhaseCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CatalogPhaseCancelled'
  }
}

/** The default executor: one query after the other, through `query`. */
export function sequentialExecutor(query: CatalogQuery): CatalogPhaseExecutor {
  return async ({ queries, starting, onRows, signal }) => {
    for (const q of queries) {
      signal.throwIfAborted()
      starting(q.offset)
      await onRows(q.offset, await query(q.sql, signal))
    }
  }
}

/**
 * Shortest gap between two writes of the cache, in milliseconds.
 *
 * Progress is counted in units and a pause writes what it has, so this only
 * trades how much a crash could lose against how often the cache — which can
 * hold a few hundred thousand cells — is re-serialized.
 */
const SAVE_EVERY_MS = 5000

export interface CatalogStepProgress {
  done: number
  /** Null until the step's units are planned (the crossings wait on the rankings). */
  total: number | null
}

export interface CatalogComputationInput {
  catalog: DataCatalog
  mapping: SchemaMapping
  query: CatalogQuery
  /** A paused run's cache to resume from, or null for a fresh start. */
  resumeFrom: CatalogResultCache | null
  /** Write the cache back after each save point, so a later call resumes. */
  persist: (cache: CatalogResultCache, done: boolean) => Promise<void>
  /** How each phase's queries run; one by one through `query` when absent. */
  executor?: CatalogPhaseExecutor
}

/** What a watcher can be told along the way; every hook is optional. */
export interface CatalogComputationHooks {
  step?: (step: CatalogRunStep) => void
  unit?: (info: CatalogUnitInfo) => void
  /** Percent of its data the query in flight has read; null when unknown or once it is done. */
  reading?: (pct: number | null) => void
  /** Units done so far, per step, and the planned total once known. */
  progress?: (computed: number, steps: Partial<Record<CatalogRunStep, CatalogStepProgress>>, total: number | null) => void
  saved?: (computed: number) => void
  /** Every unit is done; the finished cache is being written. */
  finishing?: () => void
}

function stepCounts(units: readonly CatalogRunUnit[], offset: number, base: Partial<Record<CatalogRunStep, CatalogStepProgress>> = {}) {
  const steps: Partial<Record<CatalogRunStep, CatalogStepProgress>> = { ...base }
  units.forEach((u, i) => {
    const s = steps[u.info.step] ?? { done: 0, total: 0 }
    steps[u.info.step] = { done: s.done + (i < offset ? 1 : 0), total: (s.total ?? 0) + 1 }
  })
  return steps
}

/**
 * Size the warehouse, then the base units (concept list, totals, rankings),
 * then the crossing units planned from those rankings.
 *
 * Resolves 'done' once the finished cache is written, or 'paused' when `signal`
 * aborts — after writing every unit finished so far. Any other failure throws.
 */
export async function runCatalogComputation(
  input: CatalogComputationInput,
  signal: AbortSignal,
  hooks: CatalogComputationHooks = {},
): Promise<'done' | 'paused'> {
  const { catalog, mapping, query, persist } = input
  const execute = input.executor ?? sequentialExecutor(query)
  const startedAt = Date.now()
  let state: CatalogRunState = emptyRunState()
  let offset = 0
  let savedOffset = 0
  let plan: CrossingPlan | null = null
  let job: { id: string; phase: CatalogPhase } | null = null
  let base: Pick<CatalogResultCache, 'catalogId' | 'computedAt' | 'durationMs'> = { catalogId: catalog.id, computedAt: new Date().toISOString(), durationMs: 0 }

  const save = async (done: boolean) => {
    const order = plan?.crossings ?? effectiveCrossings(catalog)
    const cache = cacheFromState({ ...base, labels: plan?.labels }, state, order, offset)
    if (job && cache.work) cache.work.job = job
    if (done) {
      cache.modalities = orderModalities(catalog, cache.crossings)
      cache.durationMs = Date.now() - startedAt
      cache.computedAt = new Date().toISOString()
      delete cache.work
    }
    await persist(cache, done)
    savedOffset = offset
    hooks.saved?.(offset)
  }

  try {
    const resumed = input.resumeFrom?.work ? input.resumeFrom : null
    if (resumed) {
      state = stateFromCache(resumed)
      job = resumed.work?.job ?? null
      offset = resumed.completedSteps ?? 0
      savedOffset = offset
      base = { catalogId: catalog.id, computedAt: resumed.computedAt, durationMs: resumed.durationMs }
    } else {
      hooks.step?.('sizing')
      hooks.progress?.(0, { sizing: { done: 0, total: 1 } }, null)
      state.slices = await planSlices(mapping, query, signal)
    }
    const sized = { sizing: { done: 1, total: 1 } }

    let savedAt = Date.now()
    let step: CatalogRunStep | null = null
    let total: number | null = null
    const runUnits = async (units: readonly CatalogRunUnit[], first: number, all: () => CatalogRunUnit[], phase: CatalogPhase) => {
      const announce = (at: number) => {
        const unit = units[at - first]
        if (unit.info.step !== step) hooks.step?.((step = unit.info.step))
        hooks.unit?.(unit.info)
      }
      const advance = async (rows: readonly Record<string, unknown>[]) => {
        announce(offset)
        units[offset - first].apply(state, rows)
        offset++
        hooks.reading?.(null)
        hooks.progress?.(offset, stepCounts(all(), offset, sized), total)
        if (Date.now() - savedAt >= SAVE_EVERY_MS) {
          await save(false)
          savedAt = Date.now()
        }
      }
      // A unit without a query takes its place before the next query's rows.
      const catchUp = async (to: number) => {
        while (offset < to) await advance([])
      }
      const queries = units.slice(offset - first).flatMap((u, i) => (u.sql ? [{ offset: offset + i, sql: u.sql }] : []))
      if (queries.length) {
        await execute({
          name: phase,
          queries,
          resumeJob: job?.phase === phase ? job.id : null,
          jobStarted: async (id) => {
            job = { id, phase }
            await save(false)
          },
          starting: (at, reading) => {
            announce(at)
            hooks.reading?.(reading ?? null)
          },
          onRows: async (at, rows) => {
            signal.throwIfAborted()
            // Already added in: a resumed job hands back what it finished.
            if (at < offset) return
            await catchUp(at)
            await advance(rows)
          },
          signal,
        })
      }
      signal.throwIfAborted()
      await catchUp(first + units.length)
      if (job?.phase === phase) job = null
    }

    const baseList = baseUnits(catalog, mapping, state.slices)
    hooks.progress?.(offset, { ...stepCounts(baseList, offset, sized), crossings: { done: 0, total: null } }, null)
    await runUnits(baseList, 0, () => baseList, 'base')
    signal.throwIfAborted()

    plan = planCrossings(catalog, mapping, state)
    const crossingUnits = plan.units
    const everything = () => [...baseList, ...crossingUnits]
    total = baseList.length + crossingUnits.length
    hooks.progress?.(offset, stepCounts(everything(), offset, sized), total)
    await runUnits(crossingUnits, baseList.length, everything, 'crossings')
    signal.throwIfAborted()

    hooks.finishing?.()
    await save(true)
    return 'done'
  } catch (err) {
    if (!signal.aborted && !(err instanceof CatalogPhaseCancelled)) throw err
    // A pause keeps every unit finished so far, not just the last save point.
    if (offset > savedOffset) {
      try { await save(false) } catch { /* the next resume redoes the unsaved units */ }
    }
    return 'paused'
  }
}
