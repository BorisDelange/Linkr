import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Eye, EyeOff, AlertTriangle, Replace } from 'lucide-react'
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

  // Compute anonymization impact
  const impact = useMemo(() => {
    const allRows = [...cache.concepts, ...cache.dimensions]
    const affectedRows = allRows.filter((r) => r.patientCount < previewThreshold).length
    const unaffectedRows = allRows.length - affectedRows

    // Per-concept analysis: a concept can have rows both above and below threshold
    // (e.g. from different dictionaries). "Partial" = has both above and below rows.
    const conceptBuckets = new Map<string | number, { above: number; below: number }>()
    for (const row of cache.concepts) {
      const key = row.conceptId
      const bucket = conceptBuckets.get(key) ?? { above: 0, below: 0 }
      if (row.patientCount < previewThreshold) bucket.below++
      else bucket.above++
      conceptBuckets.set(key, bucket)
    }
    let lostConcepts = 0
    let partialConcepts = 0
    for (const bucket of conceptBuckets.values()) {
      if (bucket.above === 0) lostConcepts++ // all rows below threshold
      else if (bucket.below > 0) partialConcepts++ // some rows below, some above
    }

    const affectedPct = allRows.length > 0 ? Math.round((affectedRows / allRows.length) * 100) : 0
    const unaffectedPct = allRows.length > 0 ? Math.round((unaffectedRows / allRows.length) * 100) : 100
    const partialPct = cache.concepts.length > 0 ? Math.round((partialConcepts / conceptBuckets.size) * 100) : 0

    return {
      totalRows: allRows.length,
      affectedRows,
      affectedPct,
      unaffectedRows,
      unaffectedPct,
      totalConcepts: conceptBuckets.size,
      lostConcepts,
      partialConcepts,
      partialPct,
      retainedPct: unaffectedPct,
    }
  }, [cache.concepts, cache.dimensions, previewThreshold])

  const handleSave = async () => {
    await updateCatalog(catalog.id, {
      anonymization: { threshold: previewThreshold, mode },
    })
  }

  const affectedLabel = mode === 'replace' ? t('data_catalog.anon_replaced_rows') : t('data_catalog.anon_suppressed_rows')
  const conceptsValue = mode === 'suppress' ? impact.lostConcepts : impact.partialConcepts

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
          icon={mode === 'replace' ? <Replace size={18} /> : <EyeOff size={18} />}
          iconBg={mode === 'replace' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}
          value={impact.affectedRows.toLocaleString()}
          label={affectedLabel}
          detail={<Share pct={impact.affectedPct} className="text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          icon={<Eye size={18} />}
          iconBg="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          value={impact.unaffectedRows.toLocaleString()}
          label={t('data_catalog.anon_retained_rows')}
          detail={<Share pct={impact.unaffectedPct} className="text-emerald-600 dark:text-emerald-400" />}
        />
        <StatCard
          icon={<AlertTriangle size={18} />}
          iconBg="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          value={conceptsValue.toLocaleString()}
          label={mode === 'suppress' ? t('data_catalog.anon_lost_concepts') : t('data_catalog.anon_partial_concepts')}
          detail={<Share pct={impact.partialPct} className="text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          icon={<ShieldCheck size={18} />}
          iconBg={`${ENTITY_COLORS['data-catalog'].bg} ${ENTITY_COLORS['data-catalog'].icon}`}
          value={`${impact.retainedPct}%`}
          label={t('data_catalog.anon_retained_pct')}
          detail={<Progress value={impact.retainedPct} className="mt-1.5 h-1.5" />}
        />
      </div>

      <Card className="grid grid-cols-2 gap-4 p-5 lg:grid-cols-4">
        <Figure label={t('data_catalog.anon_total_rows')} value={impact.totalRows.toLocaleString()} />
        <Figure label={t('data_catalog.anon_total_concepts')} value={impact.totalConcepts.toLocaleString()} />
        <Figure label={t('data_catalog.anon_partial_concepts')} value={`${impact.partialConcepts.toLocaleString()} (${impact.partialPct}%)`} />
        <Figure label={t('data_catalog.anon_lost_concepts')} value={impact.lostConcepts.toLocaleString()} />
      </Card>
    </div>
  )
}

function Share({ pct, className }: { pct: number; className?: string }) {
  return <span className={cn('text-sm font-semibold tabular-nums', className)}>{pct}%</span>
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}
