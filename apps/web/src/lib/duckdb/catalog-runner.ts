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
import type { CatalogQuery, CatalogRunStep, CatalogUnitInfo } from './catalog-compute'
import { runCatalogComputation, type CatalogStepProgress } from './catalog-run'

export type { CatalogStepProgress }

/** Where a run is: mounting, one of the counting steps, or writing the result. */
export type CatalogRunPhase = 'mounting' | CatalogRunStep | 'saving'

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

/** The run: the shared computation, its progress relayed to the watchers. */
async function loop(input: StartCatalogRunInput, controller: AbortController): Promise<void> {
  const catalogId = input.catalog.id
  const signal = controller.signal
  try {
    await input.ensureMounted()
    signal.throwIfAborted()
    await runCatalogComputation({
      catalog: input.catalog,
      mapping: input.mapping,
      query: input.query,
      resumeFrom: input.resumeFrom?.cache ?? null,
      persist: input.persist,
    }, signal, {
      step: (step) => emitNow(catalogId, { phase: step }),
      unit: (info) => emit(catalogId, { current: info }),
      progress: (computed, steps, total) => {
        if (total !== getCatalogRunSnapshot(catalogId).total) emitNow(catalogId, { computed, steps, total })
        else emit(catalogId, { computed, steps })
      },
      saved: (computed) => emitNow(catalogId, { computed }),
      finishing: () => emitNow(catalogId, { phase: 'saving', current: null }),
    })
  } catch (err) {
    if (!signal.aborted) {
      const message = err instanceof Error ? err.message : String(err)
      emit(catalogId, { error: message })
      try {
        await input.persistError(message)
      } catch {
        // The run already failed; failing to record that must not mask it.
      }
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
