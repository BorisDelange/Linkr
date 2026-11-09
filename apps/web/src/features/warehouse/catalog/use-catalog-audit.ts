import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isServerMode } from '@/lib/api-client'
import { getServerRunResult } from '@/lib/api/server-runs'
import {
  AUDIT_RUN_RESULT,
  auditRunApplies,
  auditRunMatches,
  compileAuditRun,
  getAuditSnapshot,
  startAudit,
  stopAudit,
  watchAudit,
  type AuditRunSnapshot,
  type AuditRunState,
} from '@/lib/data-catalog/audit-runner'
import { getStorage } from '@/lib/storage'
import { localized } from '@/lib/localized'
import { useServerRun } from '@/hooks/use-server-run'
import { useCatalogStore } from '@/stores/catalog-store'
import type { AnonymizationAudit, CatalogResultCache, DataCatalog } from '@/types'

export interface CatalogAuditView extends AuditRunSnapshot {
  /** A run of these results and settings stopped midway: `start` goes on from there. */
  paused: boolean
  start: () => void
  stop: () => void
}

/**
 * A catalog's disclosure audit, wherever it runs: in server mode — for whoever
 * may keep its result — a run of the server's, found again after a reload and
 * kept once done; otherwise in this page (`audit-runner`).
 */
export function useCatalogAudit(catalog: DataCatalog, cache: CatalogResultCache, canWrite: boolean): CatalogAuditView {
  const { t, i18n } = useTranslation()
  const { setResultCache } = useCatalogStore()
  const onServer = isServerMode() && canWrite

  const [local, setLocal] = useState<AuditRunSnapshot>(() => getAuditSnapshot(catalog.id))
  useEffect(() => (onServer ? undefined : watchAudit(catalog.id, setLocal)), [catalog.id, onServer])
  const serverRun = useServerRun<AuditRunState>('catalog_audit', catalog.id, onServer)
  const [applyError, setApplyError] = useState<string | null>(null)

  const persist = useCallback(async (result: AnonymizationAudit) => {
    // The latest results, not the ones the audit started from: the tab may have saved the impact meanwhile.
    const store = useCatalogStore.getState()
    const current = (store.resultCacheLoadedFor === catalog.id ? store.activeResultCache : null) ?? cache
    const next = { ...current, anonymizationAudit: result }
    setResultCache(catalog.id, next)
    if (canWrite) await getStorage().catalogResults.save(next)
  }, [catalog.id, cache, canWrite, setResultCache])

  const run = serverRun.run
  const applied = useRef<string | null>(null)
  useEffect(() => {
    if (!run || applied.current === run.id || !auditRunApplies(run, catalog, cache)) return
    applied.current = run.id
    void getServerRunResult<AnonymizationAudit>(run.id, AUDIT_RUN_RESULT)
      .then(persist)
      .catch((err) => setApplyError(err instanceof Error ? err.message : String(err)))
  }, [run, catalog, cache, persist])

  const paused = onServer && !!run && (run.status === 'paused' || run.status === 'interrupted') && auditRunMatches(run, catalog, cache)
  const { start: startRun, resume, pause } = serverRun
  const start = useCallback(() => {
    if (!onServer) {
      startAudit({ catalog, cache, persist })
      return
    }
    setApplyError(null)
    const label = t('data_catalog.audit_run_label', { name: localized(catalog.name, i18n.language) })
    // Shown from the reader's error.
    void (paused ? resume() : startRun(compileAuditRun(catalog, cache, label))).catch(() => {})
  }, [onServer, paused, catalog, cache, persist, resume, startRun, t, i18n.language])
  const stop = useCallback(() => {
    if (onServer) void pause().catch(() => {})
    else stopAudit(catalog.id)
  }, [onServer, pause, catalog.id])

  if (!onServer) return { ...local, paused: false, start, stop }
  const st = run?.state ?? {}
  return {
    running: serverRun.active,
    done: st.next ?? 0,
    total: st.total ?? null,
    error: (run?.status === 'failed' ? run.error : null) ?? serverRun.error ?? applyError,
    paused,
    start,
    stop,
  }
}
