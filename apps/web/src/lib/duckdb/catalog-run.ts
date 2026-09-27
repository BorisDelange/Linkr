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
}

/** What a watcher can be told along the way; every hook is optional. */
export interface CatalogComputationHooks {
  step?: (step: CatalogRunStep) => void
  unit?: (info: CatalogUnitInfo) => void
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
  const startedAt = Date.now()
  let state: CatalogRunState = emptyRunState()
  let offset = 0
  let savedOffset = 0
  let plan: CrossingPlan | null = null
  let base: Pick<CatalogResultCache, 'catalogId' | 'computedAt' | 'durationMs'> = { catalogId: catalog.id, computedAt: new Date().toISOString(), durationMs: 0 }

  const save = async (done: boolean) => {
    const order = plan?.crossings ?? effectiveCrossings(catalog)
    const cache = cacheFromState({ ...base, labels: plan?.labels }, state, order, offset)
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
    const runUnits = async (units: readonly CatalogRunUnit[], first: number, all: () => CatalogRunUnit[]) => {
      for (let i = offset - first; i < units.length; i++) {
        signal.throwIfAborted()
        const unit = units[i]
        if (unit.info.step !== step) hooks.step?.((step = unit.info.step))
        hooks.unit?.(unit.info)
        await unit.run(state, signal)
        offset++
        hooks.progress?.(offset, stepCounts(all(), offset, sized), total)
        if (Date.now() - savedAt >= SAVE_EVERY_MS) {
          await save(false)
          savedAt = Date.now()
        }
      }
    }

    const baseList = baseUnits(catalog, mapping, query, state.slices)
    hooks.progress?.(offset, { ...stepCounts(baseList, offset, sized), crossings: { done: 0, total: null } }, null)
    await runUnits(baseList, 0, () => baseList)
    signal.throwIfAborted()

    plan = planCrossings(catalog, mapping, query, state)
    const crossingUnits = plan.units
    const everything = () => [...baseList, ...crossingUnits]
    total = baseList.length + crossingUnits.length
    hooks.progress?.(offset, stepCounts(everything(), offset, sized), total)
    await runUnits(crossingUnits, baseList.length, everything)
    signal.throwIfAborted()

    hooks.finishing?.()
    await save(true)
    return 'done'
  } catch (err) {
    if (!signal.aborted) throw err
    // A pause keeps every unit finished so far, not just the last save point.
    if (offset > savedOffset) {
      try { await save(false) } catch { /* the next resume redoes the unsaved units */ }
    }
    return 'paused'
  }
}
