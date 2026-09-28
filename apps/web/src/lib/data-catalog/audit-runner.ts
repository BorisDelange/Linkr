/**
 * Keeps a catalog's disclosure audit running while its tab is not shown —
 * the same contract as the computation's runner (lib/duckdb/catalog-runner.ts):
 * the run belongs to the catalog, the tab watches it and re-attaches on
 * return, and only a stop, the end, or an error ends it.
 */

import type { AnonymizationAudit, CatalogResultCache, DataCatalog } from '@/types'
import { auditCatalog } from './audit'

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
