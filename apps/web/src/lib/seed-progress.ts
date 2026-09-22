/**
 * Progress of the first-run seed, for the boot screen.
 *
 * The seed is the longest thing a first visitor waits on (tens of MB of bundled
 * content, plus DuckDB's wasm on top), and it used to run with nothing on screen
 * to say so: phase 1 sat behind a bare spinner, phase 2 ran after the app had
 * already rendered, so the shell looked ready while its content was still being
 * written. This carries what the loader is doing to whoever is waiting.
 *
 * Deliberately not a store: it is written from plain async functions outside React
 * and read by one component, so it is a module-level value with subscribers.
 */

export type SeedPhase = 'idle' | 'structure' | 'data' | 'done'

export interface SeedProgress {
  phase: SeedPhase
  /** What is being loaded right now, already translated into the user's language. */
  label: string
  /** Units finished and expected in this phase; `total` 0 means "not counted yet". */
  done: number
  total: number
  /** Milliseconds since the seed started, for the estimate. */
  elapsedMs: number
}

const initial: SeedProgress = { phase: 'idle', label: '', done: 0, total: 0, elapsedMs: 0 }

let current: SeedProgress = initial
let startedAt = 0
const listeners = new Set<() => void>()

function emit(next: Partial<SeedProgress>): void {
  current = { ...current, ...next, elapsedMs: startedAt ? Date.now() - startedAt : 0 }
  for (const l of listeners) l()
}

export function subscribeSeedProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Snapshot for `useSyncExternalStore` — stable identity between emissions. */
export function getSeedProgress(): SeedProgress {
  return current
}

/**
 * Open a phase.
 *
 * Phase 1 ends at 100% and phase 2 then starts from 0, which showed the bar
 * filling, snapping back to empty and filling again. The two phases are one wait
 * to whoever is watching, so they share one scale: phase 2 adds its entities to
 * the running total and keeps counting from where phase 1 stopped.
 */
export function beginSeedPhase(phase: Exclude<SeedPhase, 'idle' | 'done'>, total: number): void {
  if (!startedAt) startedAt = Date.now()
  phaseOffset = phase === 'structure' ? 0 : current.done
  emit({ phase, total: phaseOffset + total, done: phaseOffset, label: '' })
}

/** Units finished before the current phase — what its own counter is offset by. */
let phaseOffset = 0

/** `done` counts within the current phase; the shared scale adds what came before. */
export function reportSeedStep(label: string, done: number): void {
  emit({ label, done: phaseOffset + done })
}

export function endSeed(): void {
  emit({ phase: 'done', label: '', done: current.total })
}

/**
 * Whether a first-run install is under way — phase 1, phase 2, or the gap
 * between them.
 *
 * Phase 1 finishes, then phase 2 has to read the manifests back before it knows
 * whether it has anything to do, and the app rendered in that gap: the UI flashed
 * for ~100ms between two boot screens. `structure` opening the install is what
 * says the whole thing is still going; only `endSeed` closes it.
 */
export function isSeedRunning(): boolean {
  return current.phase === 'structure' || current.phase === 'data'
}

/**
 * Remaining milliseconds, extrapolated from the units already done, or null while
 * there is not enough to extrapolate from. One unit is far too little to predict
 * anything (the first is usually the slowest), hence the floor of two.
 */
export function estimateRemainingMs(p: SeedProgress): number | null {
  if (p.done < 2 || p.total <= 0 || p.done >= p.total) return null
  const perUnit = p.elapsedMs / p.done
  return Math.round(perUnit * (p.total - p.done))
}
