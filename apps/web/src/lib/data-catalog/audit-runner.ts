/**
 * Keeps a catalog's disclosure audit running while its tab is not shown —
 * the same contract as the computation's runner (lib/duckdb/catalog-runner.ts):
 * the run belongs to the catalog, the tab watches it and re-attaches on
 * return, and only a stop, the end, or an error ends it.
 *
 * In server mode the audit is a run of the server's (`catalog_audit`, apps/api
 * services/server_runs/catalog_audit): the page builds what would be published
 * (`compileAuditRun`), the server solves it, and the page keeps a finished run's
 * audit with the results it audited (`auditRunApplies`) — a reload or a closed
 * tab loses nothing.
 */

import type { ServerRun } from '@/lib/api/server-runs'
import type { AnonymizationAudit, CatalogResultCache, DataCatalog } from '@/types'
import { auditCatalog, auditInputOf, type AuditInput, type AuditStamp } from './audit'

export interface AuditRunSnapshot {
  running: boolean
  /** Systems solved, and how many there are (null until planned). */
  done: number
  total: number | null
  error: string | null
}

const IDLE: AuditRunSnapshot = { running: false, done: 0, total: null, error: null }
const PROGRESS_THROTTLE_MS = 100

interface Run {
  snapshot: AuditRunSnapshot
  controller: AbortController
  watchers: Set<(s: AuditRunSnapshot) => void>
  notifiedAt: number
}

const runs = new Map<string, Run>()

function emit(catalogId: string, patch: Partial<AuditRunSnapshot>, now = false): void {
  const run = runs.get(catalogId)
  if (!run) return
  run.snapshot = { ...run.snapshot, ...patch }
  const t = Date.now()
  if (!now && t - run.notifiedAt < PROGRESS_THROTTLE_MS) return
  run.notifiedAt = t
  for (const w of run.watchers) w(run.snapshot)
}

export function getAuditSnapshot(catalogId: string): AuditRunSnapshot {
  return runs.get(catalogId)?.snapshot ?? IDLE
}

/** Watch a catalog's audit. Unsubscribing does not stop it. */
export function watchAudit(catalogId: string, watcher: (s: AuditRunSnapshot) => void): () => void {
  let run = runs.get(catalogId)
  if (!run) runs.set(catalogId, (run = { snapshot: IDLE, controller: new AbortController(), watchers: new Set(), notifiedAt: 0 }))
  run.watchers.add(watcher)
  return () => { runs.get(catalogId)?.watchers.delete(watcher) }
}

export function stopAudit(catalogId: string): void {
  runs.get(catalogId)?.controller.abort()
}

export interface StartAuditInput {
  catalog: DataCatalog
  cache: CatalogResultCache
  /** Keep the audit with the results it audited. */
  persist: (audit: AnonymizationAudit) => Promise<void>
}

/** Start an audit; a no-op while one runs for this catalog. */
export function startAudit({ catalog, cache, persist }: StartAuditInput): void {
  const existing = runs.get(catalog.id)
  if (existing?.snapshot.running) return
  const controller = new AbortController()
  const run: Run = { snapshot: { running: true, done: 0, total: null, error: null }, controller, watchers: existing?.watchers ?? new Set(), notifiedAt: 0 }
  runs.set(catalog.id, run)
  emit(catalog.id, {}, true)
  void (async () => {
    try {
      const audit = await auditCatalog(catalog, cache, {
        signal: controller.signal,
        progress: (done, total) => emit(catalog.id, { done, total }, done === total),
      })
      await persist(audit)
    } catch (err) {
      if (!controller.signal.aborted) emit(catalog.id, { error: err instanceof Error ? err.message : String(err) }, true)
    } finally {
      emit(catalog.id, { running: false }, true)
    }
  })()
}

/** A `catalog_audit` run's checkpoint, as the page reads it. */
export interface AuditRunState {
  /** Systems solved, out of `total`. */
  next?: number
  total?: number
  /** What its audit will be stamped with. */
  meta?: AuditStamp
  /** Set once done: its audit's `computedAt`. */
  computedAt?: string
}

/** The run's result file (`results/audit.json`). */
export const AUDIT_RUN_RESULT = 'audit'

export interface AuditRunSpec {
  label: string
  input: AuditInput
  meta: AuditStamp
}

export function compileAuditRun(catalog: DataCatalog, cache: CatalogResultCache, label: string): AuditRunSpec {
  const { input, stamp } = auditInputOf(catalog, cache)
  return { label, input, meta: stamp }
}

/** Whether a run audits these results under these settings. */
export function auditRunMatches(run: ServerRun<AuditRunState>, catalog: Pick<DataCatalog, 'anonymization'>, cache: CatalogResultCache): boolean {
  const meta = run.state.meta
  const { threshold, mode = 'replace', noise = 0 } = catalog.anonymization
  return !!meta && meta.threshold === threshold && meta.mode === mode && meta.noise === noise && meta.resultsComputedAt === cache.computedAt
}

/**
 * Whether a run's audit is still to keep: done, of these results and settings,
 * and newer than the audit kept — which a page that already kept it, before a
 * reload or in another tab, has stamped with the same `computedAt`.
 */
export function auditRunApplies(run: ServerRun<AuditRunState>, catalog: Pick<DataCatalog, 'anonymization'>, cache: CatalogResultCache): boolean {
  const at = run.state.computedAt
  if (run.status !== 'done' || !at || !auditRunMatches(run, catalog, cache)) return false
  const kept = cache.anonymizationAudit?.computedAt
  return !kept || kept < at
}
