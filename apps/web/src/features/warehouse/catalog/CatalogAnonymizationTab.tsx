import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Eye, EyeOff, AlertTriangle, Replace } from 'lucide-react'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { computeCrossingMasks, publishedCellShare, publishedPatientShare } from '@/lib/data-catalog/suppression'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
  const { updateCatalog } = useCatalogStore()
  const [thresholdInput, setThresholdInput] = useState(String(catalog.anonymization.threshold))
  const [mode, setMode] = useState<AnonymizationMode>(catalog.anonymization.mode ?? 'replace')

  const previewThreshold = Math.max(0, parseInt(thresholdInput) || 0)
  const isDirty = previewThreshold !== catalog.anonymization.threshold || mode !== (catalog.anonymization.mode ?? 'replace')

  // What the threshold being previewed would mask, before it is saved: the
  // concept list's rows below it, and every crossing's primary and secondary cells.
  const masks = useMemo(() => computeCrossingMasks(cache.crossings ?? [], previewThreshold), [cache.crossings, previewThreshold])
  const impact = useMemo(() => {
    const lostConcepts = cache.concepts.filter((r) => r.patientCount < previewThreshold).length
    let cells = 0
    let primary = 0
    let secondary = 0
    for (const m of masks.values()) {
      cells += m.cells
      primary += m.primary
      secondary += m.secondary
    }
    const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0)
    return {
      totalConcepts: cache.concepts.length,
      lostConcepts,
      lostConceptsPct: pct(lostConcepts, cache.concepts.length),
      cells,
      primary,
      primaryPct: pct(primary, cells),
      secondary,
      secondaryPct: pct(secondary, cells),
      publishedPct: cells > 0 ? 100 - pct(primary + secondary, cells) : 100,
    }
  }, [cache.concepts, masks, previewThreshold])

  const rows = useMemo<CrossingImpact[]>(() => (cache.crossings ?? []).map((c) => {
    const m = masks.get(c.id)!
    return {
      id: c.id,
      label: c.variables.map((v) => t(`data_catalog.var_${v}`)).join(' × '),
      size: c.variables.length,
      cells: m.cells,
      primary: m.primary,
      secondary: m.secondary,
      published: Math.round(publishedCellShare(m) * 1000) / 10,
      patients: Math.round(publishedPatientShare(m) * 1000) / 10,
    }
  }), [cache.crossings, masks, t])

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

  const handleSave = async () => {
    await updateCatalog(catalog.id, {
      anonymization: { threshold: previewThreshold, mode },
    })
  }


  return (
    // Capped like the Configuration and Publish tabs: these are forms, and a
    // full-bleed one on a wide screen leaves its fields stranded from their
    // labels. The Data tab is the exception — it is a table, and wants the room.
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
              <Input
                id={id}
                type="number"
                min={0}
                value={thresholdInput}
                disabled={!canWrite}
                onChange={(e) => setThresholdInput(e.target.value)}
                className="h-8 text-xs"
              />
            )}
          </FormField>
          <FormField label={t('data_catalog.anon_mode')}>
            {({ id }) => (
              <Select value={mode} disabled={!canWrite} onValueChange={(v) => setMode(v as AnonymizationMode)}>
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
          <Button size="sm" disabled={!canWrite || !isDirty} onClick={handleSave}>
            {t('common.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === 'replace'
            ? t('data_catalog.anon_replace_hint', { threshold: previewThreshold })
            : t('data_catalog.anon_suppress_hint')}
        </p>
      </Card>

      {/* Impact of the threshold being previewed, before it is saved */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<EyeOff size={18} />}
          iconBg="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          value={impact.primary.toLocaleString()}
          label={t('data_catalog.anon_primary_cells')}
          detail={<Share pct={impact.primaryPct} className="text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          icon={<Replace size={18} />}
          iconBg="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          value={impact.secondary.toLocaleString()}
          label={t('data_catalog.anon_secondary_cells')}
          detail={<Share pct={impact.secondaryPct} className="text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          icon={<AlertTriangle size={18} />}
          iconBg="bg-red-500/10 text-red-600 dark:text-red-400"
          value={impact.lostConcepts.toLocaleString()}
          label={mode === 'suppress' ? t('data_catalog.anon_lost_concepts') : t('data_catalog.anon_masked_concepts')}
          detail={<Share pct={impact.lostConceptsPct} className="text-red-600 dark:text-red-400" />}
        />
        <StatCard
          icon={<Eye size={18} />}
          iconBg={`${ENTITY_COLORS['data-catalog'].bg} ${ENTITY_COLORS['data-catalog'].icon}`}
          value={`${impact.publishedPct}%`}
          label={t('data_catalog.anon_published_cells')}
          detail={<Progress value={impact.publishedPct} className="mt-1.5 h-1.5" />}
        />
      </div>

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
      <p className="text-xs text-muted-foreground">{t('data_catalog.anon_secondary_hint')}</p>
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


function Share({ pct, className }: { pct: number; className?: string }) {
  return <span className={cn('text-sm font-semibold tabular-nums', className)}>{pct}%</span>
}
