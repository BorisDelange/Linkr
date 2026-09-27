import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Eye, EyeOff, AlertTriangle, Loader2, Play, Replace } from 'lucide-react'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { computeAnonymizationImpact, publishedCellShare, publishedPatientShare } from '@/lib/data-catalog/suppression'
import { getStorage } from '@/lib/storage'
import { Card } from '@/components/ui/card'
import { NumberInput } from '@/components/ui/number-input'
import { FormField } from '@/components/ui/form-field'
import { FieldInfo } from '@/components/ui/field-info'
import { SectionLabel } from '@/components/ui/section-label'
import { StatCard } from '@/components/ui/stat-card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCatalogStore } from '@/stores/catalog-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { cn } from '@/lib/utils'
import { yieldClass } from './yield-class'
import type { DataCatalog, CatalogResultCache, AnonymizationMode } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

export function CatalogAnonymizationTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('catalog:write')
  const { updateCatalog, setResultCache } = useCatalogStore()
  const [threshold, setThreshold] = useState(catalog.anonymization.threshold)
  const mode: AnonymizationMode = catalog.anonymization.mode ?? 'replace'

  // The settings save as they are typed (the threshold a beat later, so each
  // keystroke is not a write). Their impact is worked out on Run — masking
  // every crossing is too heavy to follow each keystroke — and kept with the
  // results, so a visit reads it rather than redoing it. A new computation
  // replaces it with the masks of the settings it ran with.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(saveTimer.current), [])
  const changeThreshold = (next: number) => {
    setThreshold(next)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void updateCatalog(catalog.id, { anonymization: { threshold: next, mode } }), 400)
  }
  const changeMode = (next: AnonymizationMode) => {
    clearTimeout(saveTimer.current)
    void updateCatalog(catalog.id, { anonymization: { threshold, mode: next } })
  }
  const saved = cache.anonymizationImpact
  const stale = !saved || saved.threshold !== threshold || saved.mode !== mode
  const [running, setRunning] = useState(false)
  const runImpact = async () => {
    setRunning(true)
    try {
      // Let the button show its state before the masking blocks the thread.
      await new Promise((r) => setTimeout(r, 0))
      const next = { ...cache, anonymizationImpact: computeAnonymizationImpact(cache, { threshold, mode }) }
      await getStorage().catalogResults.save(next)
      setResultCache(next)
    } finally {
      setRunning(false)
    }
  }
  const previewThreshold = saved?.threshold ?? threshold

  const impact = useMemo(() => {
    const crossings = saved?.crossings ?? []
    const lostConcepts = saved?.concepts.masked ?? 0
    const totalConcepts = saved?.concepts.total ?? 0
    let cells = 0
    let primary = 0
    let secondary = 0
    for (const m of crossings) {
      cells += m.cells
      primary += m.primary
      secondary += m.secondary
    }
    const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0)
    return {
      totalConcepts,
      lostConcepts,
      lostConceptsPct: pct(lostConcepts, totalConcepts),
      cells,
      primary,
      primaryPct: pct(primary, cells),
      secondary,
      secondaryPct: pct(secondary, cells),
      publishedPct: cells > 0 ? 100 - pct(primary + secondary, cells) : 100,
    }
  }, [saved])

  const rows = useMemo<CrossingImpact[]>(() => (saved?.crossings ?? []).map((m) => {
    return {
      id: m.id,
      label: m.variables.map((v) => t(`data_catalog.var_${v}`)).join(' × '),
      size: m.variables.length,
      cells: m.cells,
      primary: m.primary,
      secondary: m.secondary,
      published: Math.round(publishedCellShare(m) * 1000) / 10,
      patients: Math.round(publishedPatientShare(m) * 1000) / 10,
    }
  }), [saved, t])

  const columns = useMemo<DataTableColumn<CrossingImpact>[]>(() => {
    const num = (id: keyof CrossingImpact, header: string, suffix = ''): DataTableColumn<CrossingImpact> => ({
      id, header, accessor: (r) => r[id] as number, display: (r) => `${(r[id] as number).toLocaleString()}${suffix}`,
      align: 'right', cellClassName: 'tabular-nums', size: 110,
    })
    return [
      { id: 'label', header: t('data_catalog.crossing'), accessor: (r) => r.label, filter: 'text', size: 240 },
      num('cells', t('data_catalog.anon_cells')),
      num('primary', t('data_catalog.anon_primary')),
      num('secondary', t('data_catalog.anon_secondary')),
      {
        ...num('published', t('data_catalog.anon_published_cells'), ' %'),
        cell: (r) => <span className={cn('tabular-nums', yieldClass(r.published))}>{`${r.published.toLocaleString()} %`}</span>,
      },
      num('patients', t('data_catalog.anon_published_patients'), ' %'),
    ]
  }, [t])


  return (
    // Capped like the Configuration and Publish tabs: these are forms, and a
    // full-bleed one on a wide screen leaves its fields stranded from their labels.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-4">
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-muted-foreground" />
          <SectionLabel as="h3">{t('data_catalog.anon_threshold_title')}</SectionLabel>
          <FieldInfo text={t('data_catalog.anon_threshold_description')} />
        </div>
        <div className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-end gap-3">
          <FormField label={t('data_catalog.threshold')}>
            {({ id }) => (
              <NumberInput
                id={id}
                min={0}
                value={threshold}
                disabled={!canWrite}
                onValueChange={changeThreshold}
                className="h-8 text-xs"
              />
            )}
          </FormField>
          <FormField label={<span className="inline-flex items-center gap-1">{t('data_catalog.anon_mode')}<FieldInfo text={mode === 'replace' ? t('data_catalog.anon_replace_hint', { threshold }) : t('data_catalog.anon_suppress_hint')} /></span>}>
            {({ id }) => (
              <Select value={mode} disabled={!canWrite} onValueChange={(v) => changeMode(v as AnonymizationMode)}>
                <SelectTrigger id={id} className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="replace" className="text-xs">{t('data_catalog.anon_mode_replace')}</SelectItem>
                  <SelectItem value="suppress" className="text-xs">{t('data_catalog.anon_mode_suppress')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <Button size="sm" className="gap-1.5" disabled={!stale || running || !canWrite} onClick={() => void runImpact()}>
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {t('data_catalog.anon_run')}
          </Button>
        </div>
        {stale && <p className="text-[10px] text-muted-foreground">{t(saved ? 'data_catalog.anon_stale' : 'data_catalog.anon_not_run')}</p>}
      </Card>

      {/* Impact of the applied settings */}
      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 transition-opacity', stale && 'opacity-60')}>
        <StatCard
          icon={<EyeOff size={18} />}
          iconBg="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          value={impact.primary.toLocaleString()}
          label={<Hinted label={t('data_catalog.anon_primary_cells')} hint={t('data_catalog.anon_primary_cells_hint', { threshold: previewThreshold })} />}
          detail={<Share pct={impact.primaryPct} className="text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          icon={<Replace size={18} />}
          iconBg="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          value={impact.secondary.toLocaleString()}
          label={<Hinted label={t('data_catalog.anon_secondary_cells')} hint={t('data_catalog.anon_secondary_cells_hint')} />}
          detail={<Share pct={impact.secondaryPct} className="text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          icon={<AlertTriangle size={18} />}
          iconBg="bg-red-500/10 text-red-600 dark:text-red-400"
          value={impact.lostConcepts.toLocaleString()}
          label={<Hinted label={(saved?.mode ?? mode) === 'suppress' ? t('data_catalog.anon_lost_concepts') : t('data_catalog.anon_masked_concepts')} hint={t('data_catalog.anon_concepts_hint', { threshold: previewThreshold })} />}
          detail={<Share pct={impact.lostConceptsPct} className="text-red-600 dark:text-red-400" />}
        />
        <StatCard
          icon={<Eye size={18} />}
          iconBg={`${ENTITY_COLORS['data-catalog'].bg} ${ENTITY_COLORS['data-catalog'].icon}`}
          value={`${impact.publishedPct}%`}
          label={<Hinted label={t('data_catalog.anon_published_cells')} hint={t('data_catalog.anon_published_cells_hint')} />}
          detail={<Progress value={impact.publishedPct} className="mt-1.5 h-1.5" />}
        />
      </div>

      {rows.length > 0 && (
        <div className="flex items-center gap-1.5 pt-2">
          <SectionLabel as="h3">{t('data_catalog.anon_per_crossing')}</SectionLabel>
          <FieldInfo text={t('data_catalog.anon_per_crossing_hint')} />
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <DataTable
            data={rows}
            columns={columns}
            rowKey={(r) => r.id}
            pageSize={50}
            initialSorting={{ columnId: 'published', desc: false }}
            emptyMessage={t('data_catalog.no_results')}
          />
        </div>
      )}
    </div>
  )
}

interface CrossingImpact {
  id: string
  label: string
  size: number
  cells: number
  primary: number
  secondary: number
  published: number
  patients: number
}


/** A stat label with its explanation behind an ⓘ. */
function Hinted({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <FieldInfo text={hint} />
    </span>
  )
}

function Share({ pct, className }: { pct: number; className?: string }) {
  return <span className={cn('text-sm font-semibold tabular-nums', className)}>{pct}%</span>
}
