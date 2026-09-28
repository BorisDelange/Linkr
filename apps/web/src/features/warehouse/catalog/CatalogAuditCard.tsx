import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Play, ScanSearch, ShieldAlert, ShieldCheck, Square } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { FieldInfo } from '@/components/ui/field-info'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { getAuditSnapshot, startAudit, stopAudit, watchAudit, type AuditRunSnapshot } from '@/lib/data-catalog/audit-runner'
import { getStorage } from '@/lib/storage'
import { useCatalogStore } from '@/stores/catalog-store'
import { formatDuration } from '@/lib/format-helpers'
import { cn } from '@/lib/utils'
import type { AnonymizationAudit, CatalogResultCache, DataCatalog } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
  canWrite: boolean
}

interface ExampleRow {
  id: string
  crossing: string
  count: string
  cell: string
  bounds: string
  lo: number
}

/**
 * The disclosure audit: tries, from the published files alone, what an
 * outsider would to narrow masked cells down (lib/data-catalog/audit.ts).
 * It runs in the background like the computation, and its result is kept
 * with the results it audited.
 */
export function CatalogAuditCard({ catalog, cache, canWrite }: Props) {
  const { t, i18n } = useTranslation()
  const { setResultCache } = useCatalogStore()
  const [run, setRun] = useState<AuditRunSnapshot>(() => getAuditSnapshot(catalog.id))
  useEffect(() => watchAudit(catalog.id, setRun), [catalog.id])

  const audit = cache.anonymizationAudit
  const { threshold, mode = 'replace', noise = 0 } = catalog.anonymization
  const stale = !!audit && (audit.threshold !== threshold || audit.mode !== mode || audit.noise !== noise || audit.resultsComputedAt !== cache.computedAt)

  const start = () => startAudit({
    catalog,
    cache,
    persist: async (result: AnonymizationAudit) => {
      // The latest results, not the ones the audit started from: the tab may have saved the impact meanwhile.
      const store = useCatalogStore.getState()
      const current = (store.resultCacheLoadedFor === catalog.id ? store.activeResultCache : null) ?? cache
      const next = { ...current, anonymizationAudit: result }
      setResultCache(catalog.id, next)
      if (canWrite) await getStorage().catalogResults.save(next)
    },
  })

  const patients = audit?.findings.filter((f) => f.measure === 'patients') ?? []
  const exposed = patients.reduce((n, f) => n + f.count, 0)
  const values = (audit?.findings ?? []).filter((f) => f.measure !== 'patients').reduce((n, f) => n + f.count, 0)

  const rows = useMemo<ExampleRow[]>(() => (audit?.findings ?? []).flatMap((f) => f.examples.map((e, i) => ({
    id: `${f.crossing}|${f.measure}|${f.kind}|${i}`,
    crossing: f.variables.map((v) => t(`data_catalog.var_${v}`)).join(' × '),
    count: t(`data_catalog.audit_measure_${f.measure}`),
    cell: e.cell.join(' · '),
    bounds: e.lo === e.hi ? String(e.lo) : `${e.lo} – ${e.hi}`,
    lo: e.lo,
  }))), [audit, t])

  const columns = useMemo<DataTableColumn<ExampleRow>[]>(() => [
    { id: 'crossing', header: t('data_catalog.crossing'), accessor: (r) => r.crossing, filter: 'select', size: 200 },
    { id: 'cell', header: t('data_catalog.audit_cell'), accessor: (r) => r.cell, filter: 'text', size: 260 },
    { id: 'count', header: t('data_catalog.audit_count'), accessor: (r) => r.count, filter: 'select', size: 130 },
    { id: 'bounds', header: t('data_catalog.audit_bounds'), accessor: (r) => r.lo, display: (r) => r.bounds, align: 'right', cellClassName: 'tabular-nums', size: 120 },
  ], [t])

  const percent = run.total ? Math.round((run.done / run.total) * 100) : 0

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-1.5">
        <ScanSearch size={14} className="text-muted-foreground" />
        <SectionLabel as="h3">{t('data_catalog.audit_title')}</SectionLabel>
        <FieldInfo text={t('data_catalog.audit_hint')} />
        <span className="flex-1" />
        {run.running ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => stopAudit(catalog.id)}>
            <Square size={14} />
            {t('data_catalog.audit_stop')}
          </Button>
        ) : (
          <Button size="sm" className="gap-1.5" onClick={start}>
            <Play size={14} />
            {t(audit ? 'data_catalog.audit_run_again' : 'data_catalog.audit_run')}
          </Button>
        )}
      </div>

      {run.running && (
        <div className="flex flex-col gap-1">
          <Progress value={percent} />
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {run.total ? t('data_catalog.audit_progress', { done: run.done.toLocaleString(i18n.language), total: run.total.toLocaleString(i18n.language) }) : t('data_catalog.audit_preparing')}
          </span>
        </div>
      )}
      {run.error && <p className="text-xs text-destructive">{run.error}</p>}
      {!audit && !run.running && <p className="text-xs text-muted-foreground">{t('data_catalog.audit_not_run')}</p>}

      {audit && (
        <div className={cn('flex flex-col gap-3 transition-opacity', (stale || run.running) && 'opacity-60')}>
          {stale && <p className="text-[10px] text-muted-foreground">{t('data_catalog.audit_stale')}</p>}
          <div className={cn('flex items-start gap-2 rounded-md border p-3 text-xs', exposed ? 'border-destructive/40 bg-destructive/5' : 'border-emerald-500/40 bg-emerald-500/5')}>
            {exposed
              ? <ShieldAlert size={16} className="mt-px shrink-0 text-destructive" />
              : <ShieldCheck size={16} className="mt-px shrink-0 text-emerald-600 dark:text-emerald-400" />}
            <div className="flex flex-col gap-1">
              <span className="font-medium">
                {exposed
                  ? t('data_catalog.audit_exposed', { count: exposed, n: exposed.toLocaleString(i18n.language), max: audit.threshold - 1 })
                  : t('data_catalog.audit_safe')}
              </span>
              {values > 0 && <span className="text-muted-foreground">{t('data_catalog.audit_values', { count: values, n: values.toLocaleString(i18n.language) })}</span>}
              {exposed > 0 && <span className="text-muted-foreground">{t('data_catalog.audit_fix')}</span>}
            </div>
          </div>
          {rows.length > 0 && (
            <div className="overflow-hidden rounded-lg border bg-card">
              <DataTable data={rows} columns={columns} rowKey={(r) => r.id} pageSize={20} emptyMessage={t('data_catalog.no_results')} />
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            {t('data_catalog.audit_footer', {
              duration: formatDuration(audit.durationMs),
              systems: audit.components.toLocaleString(i18n.language),
              unknowns: audit.unknowns.toLocaleString(i18n.language),
              noise: audit.noise,
            })}
            {audit.inconsistent > 0 && ` ${t('data_catalog.audit_inconsistent', { n: audit.inconsistent.toLocaleString(i18n.language) })}`}
          </p>
        </div>
      )}
    </Card>
  )
}
