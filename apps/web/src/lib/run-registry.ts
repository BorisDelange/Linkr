/**
 * Long runs that belong to an entity, not to the view that started them.
 *
 * Counting a large warehouse takes minutes to hours, and a user who leaves the
 * tab has not asked for the work to stop. The loop lives in a module-level
 * registry keyed by the entity; views watch it, render whatever it reports,
 * and re-attach on return. Only a pause, the end, or an error stops a run.
 *
 * One run per key at a time. A start asked for while a paused run is still
 * winding down (landing its last save) waits for it, then begins.
 */

export interface RunSnapshotBase {
  running: boolean
  error: string | null
}

/**
 * Report progress. Anything sent with `immediate` — a phase, a total — reaches
 * the watchers at once; bare progress is throttled, since a fast unit could
 * otherwise re-render the view thousands of times over a run.
 */
export type RunEmit<S> = (patch: Partial<S>, immediate?: boolean) => void

export interface RunRegistryOptions<I, S extends RunSnapshotBase> {
  idle: S
  /** The snapshot a run starts from, `running` aside. */
  initial?: (input: I) => Partial<S>
  /** The run itself. Resolves on success or pause (`signal` aborted); throws on failure. */
  execute: (input: I, signal: AbortSignal, emit: RunEmit<S>) => Promise<void>
  /** Record a failure where a reload will see it. */
  onError?: (input: I, message: string) => Promise<void>
}

export interface RunRegistry<I, S extends RunSnapshotBase> {
  get: (key: string) => S
  /** Watch a key's run. Unsubscribing does NOT stop it. */
  watch: (key: string, watcher: (snapshot: S) => void) => () => void
  /** Start (or resume). A no-op while a run is in flight for this key. */
  start: (key: string, input: I) => void
  /** Stop now; `execute` sees its signal aborted. */
  pause: (key: string) => void
  /** Forget a finished run's error, so the next start renders clean. */
  clearError: (key: string) => void
}

const PROGRESS_THROTTLE_MS = 100

interface Run<S> {
  snapshot: S
  controller: AbortController
  watchers: Set<(snapshot: S) => void>
  notifiedAt: number
}

export function createRunRegistry<I, S extends RunSnapshotBase>(opts: RunRegistryOptions<I, S>): RunRegistry<I, S> {
  const runs = new Map<string, Run<S>>()
  const pending = new Map<string, Set<(snapshot: S) => void>>()
  const queued = new Map<string, I>()

  const emitFor = (key: string): RunEmit<S> => (patch, immediate = false) => {
    const run = runs.get(key)
    if (!run) return
    run.snapshot = { ...run.snapshot, ...patch }
    const now = Date.now()
    if (!immediate && now - run.notifiedAt < PROGRESS_THROTTLE_MS) return
    run.notifiedAt = now
    for (const watcher of run.watchers) watcher(run.snapshot)
  }

  const get = (key: string) => runs.get(key)?.snapshot ?? opts.idle

  const watch = (key: string, watcher: (snapshot: S) => void) => {
    const run = runs.get(key)
    if (run) run.watchers.add(watcher)
    // No run yet: hold the watcher so a run started elsewhere picks it up.
    else pending.set(key, (pending.get(key) ?? new Set()).add(watcher))
    // Looked up at unsubscribe time: a run started since took the pending watchers.
    return () => {
      pending.get(key)?.delete(watcher)
      const current = runs.get(key)
      if (!current) return
      current.watchers.delete(watcher)
      // A finished run kept only for its watchers goes with the last of them.
      if (current.watchers.size === 0 && !current.snapshot.running && !current.snapshot.error) runs.delete(key)
    }
  }

  const start = (key: string, input: I) => {
    const current = runs.get(key)
    if (current?.snapshot.running) {
      if (current.controller.signal.aborted) queued.set(key, input)
      return
    }
    const controller = new AbortController()
    const run: Run<S> = {
      snapshot: { ...opts.idle, ...opts.initial?.(input), running: true, error: null },
      controller,
      // Carry over the watchers of the previous run's entry: a restart must not orphan them.
      watchers: current?.watchers ?? pending.get(key) ?? new Set(),
      notifiedAt: 0,
    }
    pending.delete(key)
    runs.set(key, run)
    for (const watcher of run.watchers) watcher(run.snapshot)
    void loop(key, input, controller)
  }

  const loop = async (key: string, input: I, controller: AbortController) => {
    const emit = emitFor(key)
    try {
      await opts.execute(input, controller.signal, emit)
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        emit({ error: message } as Partial<S>, true)
        try {
          await opts.onError?.(input, message)
        } catch {
          // The run already failed; failing to record that must not mask it.
        }
      }
    } finally {
      const run = runs.get(key)
      // Keep the error for a watcher that mounts after the failure; drop the live
      // progress so views fall back to what the run persisted.
      const error = run?.snapshot.error ?? null
      emit({ ...opts.idle, error }, true)
      if (run && run.watchers.size === 0 && !error) runs.delete(key)
      const next = queued.get(key)
      if (next !== undefined) {
        queued.delete(key)
        start(key, next)
      }
    }
  }

  const pause = (key: string) => {
    queued.delete(key)
    runs.get(key)?.controller.abort()
  }

  const clearError = (key: string) => {
    const run = runs.get(key)
    if (!run || run.snapshot.running) return
    emitFor(key)({ error: null } as Partial<S>, true)
    if (run.watchers.size === 0) runs.delete(key)
  }

  return { get, watch, start, pause, clearError }
}
