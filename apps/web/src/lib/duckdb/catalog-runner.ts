/**
 * Keeps a catalog computation running while nobody is watching it.
 *
 * The run belongs to the CATALOG, not to the tab that started it. Counting a
 * real warehouse's concepts and crossing its variables takes minutes to hours, and
 * a user who leaves the Configuration tab to look at the data — or at another
 * catalog entirely — has not asked for the work to stop. Owning the loop in the
 * component meant its unmount cleanup abandoned it: the store still said
 * "computing" while nothing was running, and the only way out was the
 * stuck-status recovery in `loadCatalogs`.
 *
 * So the loop lives here, in a module-level registry keyed by catalog id, and
 * the tab subscribes to it: it renders whatever the run reports and re-attaches
 * on return. Only an explicit pause, a finished run, or an error stops it.
 *
 * The unit of progress is ONE QUERY: a dictionary's concept counts, a
 * ranking, a crossing — each over one slice of the patients when the warehouse
 * is too large to count in one go (see `planSlices`). Every unit adds its
 * counts into the run state, the stored offset counts the units in the cache,
 * and a resume picks up at the next one. Pausing interrupts the query in
 * flight, so it costs at most that one unit.
 *
 * One run per catalog at a time: the loop appends crossing rows to a single cache
 * and writes it back at each save point, so two concurrent runs on the same
 * catalog would interleave their writes and lose rows.
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
 * Not a user setting: progress is counted in units and a pause writes what it
 * has, so this only trades how much a crash could lose against how often the
 * cache — which can hold a few hundred thousand cells — is re-serialized.
 */
const SAVE_EVERY_MS = 5000

/** Where a run is: mounting, one of the counting steps, or writing the result. */
export type CatalogRunPhase = 'mounting' | CatalogRunStep | 'saving'

export interface CatalogStepProgress {
  done: number
  /** Null until the step's units are planned (the crossings wait on the rankings). */
  total: number | null
}

/** What a watcher needs to render, whether or not it started the run. */
export interface CatalogRunSnapshot {
  running: boolean
  phase: CatalogRunPhase | null
  /** Live unit offset, or null when no run is in flight. */
  computed: number | null
  /** Units this run is working towards, or null until they are planned. */
  total: number | null
  /** Units done and planned, per step. */
  steps: Partial<Record<CatalogRunStep, CatalogStepProgress>>
  /** The unit in flight. */
  current: CatalogUnitInfo | null
  error: string | null
}

const IDLE: CatalogRunSnapshot = {
  running: false, phase: null, computed: null, total: null, steps: {}, current: null, error: null,
}

interface Run {
  snapshot: CatalogRunSnapshot
  controller: AbortController
  watchers: Set<(snapshot: CatalogRunSnapshot) => void>
  /** When the watchers were last told, for the progress throttle below. */
  lastNotifiedAt: number
}

const runs = new Map<string, Run>()
const pending = new Map<string, Set<(snapshot: CatalogRunSnapshot) => void>>()

/**
 * Shortest gap between two progress notifications, in milliseconds.
 *
 * A crossing can come back in a few milliseconds on a small warehouse, and
 * every one of them re-rendered the panel: a progress bar and a reformatted
 * localized count, thousands of times over a run, all on the tab's one thread.
 * Ten updates a second is past what anyone can read and costs nothing.
 */
const PROGRESS_THROTTLE_MS = 100

/**
 * Tell the watchers, unless this is only progress and one just went out.
 *
 * Anything other than a bare position change — a phase, an error, the run
 * stopping — is delivered immediately: those are states the UI must not lag
 * behind, and they are rare.
 */
function emit(catalogId: string, patch: Partial<CatalogRunSnapshot>): void {
  const run = runs.get(catalogId)
  if (!run) return
  run.snapshot = { ...run.snapshot, ...patch }

  const onlyProgress = Object.keys(patch).every((k) => k === 'computed' || k === 'current' || k === 'steps')
  const now = Date.now()
  if (onlyProgress && now - run.lastNotifiedAt < PROGRESS_THROTTLE_MS) return
  run.lastNotifiedAt = now
  for (const watcher of run.watchers) watcher(run.snapshot)
}

/** Deliver now, whatever the throttle would have said. */
function emitNow(catalogId: string, patch: Partial<CatalogRunSnapshot>): void {
  const run = runs.get(catalogId)
  if (run) run.lastNotifiedAt = 0
  emit(catalogId, patch)
}

/** Current state of a catalog's run, for a first render. */
export function getCatalogRunSnapshot(catalogId: string): CatalogRunSnapshot {
  return runs.get(catalogId)?.snapshot ?? IDLE
}

/** Whether a run is in flight for this catalog. */
export function isCatalogRunning(catalogId: string): boolean {
  return !!runs.get(catalogId)?.snapshot.running
}

/**
 * Watch a catalog's run. Returns an unsubscribe.
 *
 * Unsubscribing does NOT stop the run — that is the whole point. A watcher that
 * goes away is a tab that was left, not a cancellation.
 */
export function watchCatalogRun(
  catalogId: string,
  watcher: (snapshot: CatalogRunSnapshot) => void,
): () => void {
  const run = runs.get(catalogId)
  if (run) {
    run.watchers.add(watcher)
    return () => { runs.get(catalogId)?.watchers.delete(watcher) }
  }
  // No run yet: hold the watcher so a run started elsewhere can pick it up.
  pending.set(catalogId, (pending.get(catalogId) ?? new Set()).add(watcher))
  return () => { pending.get(catalogId)?.delete(watcher) }
}

/** Stop a catalog's run now: the query in flight is interrupted and its unit redone on resume. */
export function pauseCatalogRun(catalogId: string): void {
  runs.get(catalogId)?.controller.abort()
}

/** Forget a finished run's error, so the next start renders clean. */
export function clearCatalogRunError(catalogId: string): void {
  const run = runs.get(catalogId)
  if (!run || run.snapshot.running) return
  emit(catalogId, { error: null })
  if (run.watchers.size === 0) runs.delete(catalogId)
}

/** Everything the loop needs that only the view can resolve. */
export interface StartCatalogRunInput {
  catalog: DataCatalog
  mapping: SchemaMapping
  /** Mount the database before the first query; the one step that must succeed. */
  ensureMounted: () => Promise<void>
  query: CatalogQuery
  /**
   * Where a resume picks up, or null for a fresh start. The cache carries every
   * count made so far and the number of units they cover.
   */
  resumeFrom: { cache: CatalogResultCache } | null
  /** Write the cache back after each save point, so a reload resumes. */
  persist: (cache: CatalogResultCache, done: boolean) => Promise<void>
  /** Record a failure on the stored catalog, so a reload shows it. */
  persistError: (message: string) => Promise<void>
}

/**
 * Start (or resume) a catalog's computation.
 *
 * Returns immediately; progress reaches watchers through `watchCatalogRun`. A
 * no-op when a run is already in flight for this catalog.
 */
export function startCatalogRun(input: StartCatalogRunInput): void {
  const catalogId = input.catalog.id
  if (runs.get(catalogId)?.snapshot.running) return

  const controller = new AbortController()
  const run: Run = {
    snapshot: {
      running: true,
      phase: 'mounting',
      computed: input.resumeFrom?.cache.completedSteps ?? 0,
      // Unknown until the crossings are planned. A restart in particular must NOT
      // inherit the previous run's total, or the bar sits on a stale count.
      total: null,
      steps: {},
      current: null,
      error: null,
    },
    controller,
    // Carry over the watchers already following this catalog: they subscribed to
    // the previous run's entry, and a restart must not orphan them.
    watchers: runs.get(catalogId)?.watchers ?? pending.get(catalogId) ?? new Set(),
    lastNotifiedAt: 0,
  }
  pending.delete(catalogId)
  runs.set(catalogId, run)
  for (const watcher of run.watchers) watcher(run.snapshot)

  void loop(input, controller)
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
 * The run: size the warehouse, then the base units (concept list, totals,
 * rankings), then the crossing units planned from those rankings. The offset
 * counts units across both lists; every unit adds into the state, and the
 * cache written at a save point holds exactly the units before the offset.
 */
async function loop(input: StartCatalogRunInput, controller: AbortController): Promise<void> {
  const { catalog, mapping, query, persist } = input
  const catalogId = catalog.id
  const signal = controller.signal
  const startedAt = performance.now()
  let state: CatalogRunState = emptyRunState()
  let offset = 0
  let savedOffset = 0
  let plan: CrossingPlan | null = null
  let base: Pick<CatalogResultCache, 'catalogId' | 'computedAt' | 'durationMs'> = { catalogId, computedAt: new Date().toISOString(), durationMs: 0 }

  const save = async (done: boolean) => {
    const order = plan?.crossings ?? effectiveCrossings(catalog)
    const cache = cacheFromState({ ...base, labels: plan?.labels }, state, order, offset)
    if (done) {
      cache.modalities = orderModalities(catalog, cache.crossings)
      cache.durationMs = Math.round(performance.now() - startedAt)
      cache.computedAt = new Date().toISOString()
      delete cache.work
    }
    await persist(cache, done)
    savedOffset = offset
  }

  try {
    await input.ensureMounted()
    signal.throwIfAborted()

    const resumed = input.resumeFrom?.cache.work ? input.resumeFrom.cache : null
    if (resumed) {
      state = stateFromCache(resumed)
      offset = resumed.completedSteps ?? 0
      savedOffset = offset
      base = { catalogId, computedAt: resumed.computedAt, durationMs: resumed.durationMs }
    } else {
      emitNow(catalogId, { phase: 'sizing', steps: { sizing: { done: 0, total: 1 } } })
      state.slices = await planSlices(mapping, query, signal)
    }
    const sized = { sizing: { done: 1, total: 1 } }

    let savedAt = Date.now()
    const runUnits = async (units: readonly CatalogRunUnit[], first: number, all: () => CatalogRunUnit[]) => {
      for (let i = offset - first; i < units.length; i++) {
        signal.throwIfAborted()
        const unit = units[i]
        if (unit.info.step !== getCatalogRunSnapshot(catalogId).phase) emitNow(catalogId, { phase: unit.info.step })
        emit(catalogId, { current: unit.info })
        await unit.run(state, signal)
        offset++
        emit(catalogId, { computed: offset, steps: stepCounts(all(), offset, sized) })
        if (Date.now() - savedAt >= SAVE_EVERY_MS) {
          await save(false)
          savedAt = Date.now()
          emitNow(catalogId, { computed: offset })
        }
      }
    }

    const baseList = baseUnits(catalog, mapping, query, state.slices)
    emitNow(catalogId, {
      computed: offset,
      total: null,
      steps: { ...stepCounts(baseList, offset, sized), crossings: { done: 0, total: null } },
    })
    await runUnits(baseList, 0, () => baseList)
    signal.throwIfAborted()

    plan = planCrossings(catalog, mapping, query, state)
    const crossingUnits = plan.units
    const everything = () => [...baseList, ...crossingUnits]
    emitNow(catalogId, { computed: offset, total: baseList.length + crossingUnits.length, steps: stepCounts(everything(), offset, sized) })
    await runUnits(crossingUnits, baseList.length, everything)
    signal.throwIfAborted()

    emitNow(catalogId, { phase: 'saving', current: null })
    await save(true)
  } catch (err) {
    if (signal.aborted) {
      // A pause keeps every unit finished so far, not just the last save point.
      if (offset > savedOffset) {
        try { await save(false) } catch { /* the next resume redoes the unsaved units */ }
      }
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    emit(catalogId, { error: message })
    try {
      await input.persistError(message)
    } catch {
      // The run already failed; failing to record that must not mask it.
    }
  } finally {
    const run = runs.get(catalogId)
    // Keep the error visible to a watcher that mounts after the failure, but drop
    // the live counts so the view falls back to the persisted ones — which by now
    // describe this run, since every save point wrote them.
    const error = run?.snapshot.error ?? null
    emitNow(catalogId, { running: false, phase: null, computed: null, total: null, steps: {}, current: null })
    if (run) {
      run.snapshot = { ...IDLE, error }
      if (run.watchers.size === 0 && !error) runs.delete(catalogId)
    }
  }
}
