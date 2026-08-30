/**
 * Keeps a catalog computation running while nobody is watching it.
 *
 * The run belongs to the CATALOG, not to the tab that started it. Counting a
 * real warehouse's concepts and walking its periods takes minutes to hours, and
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
 * The unit of progress is the PERIOD, not the query: the stored offset counts
 * period rows and a resume picks up at the next one, so pausing a long period
 * walk costs at most the handful computed since the last save. The concept and
 * dimension passes precede it and are not resumable on their own — they are one
 * aggregate query per dictionary, not a walk — so a resume replays them.
 *
 * One run per catalog at a time: the loop appends period rows to a single cache
 * and writes it back at each save point, so two concurrent runs on the same
 * catalog would interleave their writes and lose rows.
 */

import type { CatalogResultCache, DataCatalog } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import { computeCatalogBase, computePeriodBatch, type PeriodPlan } from './catalog-compute'

/**
 * Period rows computed between two writes of the cache.
 *
 * Not a user setting: progress is counted and resumed in periods, so this only
 * trades how much work a crash could lose against how often the cache is
 * re-serialized. 24 is two years of months — enough that the write is rare, few
 * enough that a pause is felt as immediate.
 */
const SAVE_EVERY = 24

/**
 * Where a run is: aggregating the concepts, or walking the periods.
 *
 * `concepts` covers the dictionary and dimension passes, which are one query per
 * dictionary against a clinical database and take long enough to be seen. Before
 * they finish there is no period plan, so neither the offset nor the total is
 * known — and a bar sitting at zero with no label reads as a button that did
 * nothing.
 */
export type CatalogRunPhase = 'mounting' | 'concepts' | 'periods' | 'saving'

/** What a watcher needs to render, whether or not it started the run. */
export interface CatalogRunSnapshot {
  running: boolean
  phase: CatalogRunPhase | null
  /** Live period offset, or null when no run is in flight. */
  computed: number | null
  /** Periods this run is walking towards, or null until they are planned. */
  total: number | null
  /** The period being computed right now, for a "what is it on" tooltip. */
  current: string | null
  error: string | null
}

const IDLE: CatalogRunSnapshot = {
  running: false, phase: null, computed: null, total: null, current: null, error: null,
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
 * A period row can come back in a few milliseconds on a small warehouse, and
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

  const onlyProgress = Object.keys(patch).every((k) => k === 'computed' || k === 'current')
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

/** Ask a catalog's run to stop after the period in flight. */
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
  query: (sql: string) => Promise<Record<string, unknown>[]>
  /**
   * Where a resume picks up. Null restarts from the concept pass.
   *
   * The cache carries the concept and dimension rows already computed, so a
   * resume re-uses them rather than re-aggregating the whole warehouse.
   */
  resumeFrom: { cache: CatalogResultCache; computed: number } | null
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
      computed: input.resumeFrom?.computed ?? 0,
      // Unknown until the periods are planned. A restart in particular must NOT
      // inherit the previous run's total, or the bar sits on a stale count.
      total: null,
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

async function loop(input: StartCatalogRunInput, controller: AbortController): Promise<void> {
  const { catalog, mapping, query, persist } = input
  const catalogId = catalog.id
  const startedAt = performance.now()
  try {
    await input.ensureMounted()
    if (controller.signal.aborted) return

    // The concept and dimension passes are one aggregate query per dictionary,
    // not a walk, so they are replayed whole on a resume rather than chunked.
    // What a resume skips is the period walk, which is where the time goes.
    let cache: CatalogResultCache
    let offset = 0
    if (input.resumeFrom) {
      cache = input.resumeFrom.cache
      offset = input.resumeFrom.computed
    } else {
      emit(catalogId, { phase: 'concepts' })
      cache = await computeCatalogBase(catalog, mapping, query, controller.signal)
      if (controller.signal.aborted) return
    }

    const plan: PeriodPlan | null = catalog.periodConfig
      ? await computePeriodBatch.plan(catalog, mapping, query)
      : null
    const total = plan?.intervals.length ?? 0
    emit(catalogId, { phase: 'periods', computed: offset, total })

    const periods = [...(cache.periods ?? [])]
    // A resume trusts the stored offset, but the cache is the authority on what
    // is actually in it: a save that failed halfway would otherwise leave the
    // walk starting past rows that were never written.
    if (periods.length < offset) offset = periods.length

    while (plan && !controller.signal.aborted && offset < total) {
      const batch = await computePeriodBatch.run(
        plan, offset, Math.min(SAVE_EVERY, total - offset), query, controller.signal,
        (n, label) => emit(catalogId, { computed: offset + n, current: label }),
      )
      // A batch that yields nothing would spin forever.
      if (batch.length === 0) break
      periods.push(...batch)
      offset += batch.length

      cache = { ...cache, periods, ...computePeriodBatch.summarize(periods) }
      await persist(cache, offset >= total)
      // Past the throttle: a save point is a real checkpoint, and letting the bar
      // sit short of it until the next tick would misreport what is stored.
      emitNow(catalogId, { computed: offset })
    }

    // A paused run keeps what it has; only a completed one is final.
    if (!controller.signal.aborted) {
      emit(catalogId, { phase: 'saving' })
      cache = {
        ...cache,
        periods: plan ? periods : undefined,
        ...(plan ? computePeriodBatch.summarize(periods) : {}),
        durationMs: Math.round(performance.now() - startedAt),
        computedAt: new Date().toISOString(),
      }
      await persist(cache, true)
    }
  } catch (err) {
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
    emit(catalogId, { running: false, phase: null, computed: null, total: null, current: null })
    if (run) {
      run.snapshot = { running: false, phase: null, computed: null, total: null, current: null, error }
      if (run.watchers.size === 0 && !error) runs.delete(catalogId)
    }
  }
}
