import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Eye, EyeOff, AlertTriangle, Replace } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import type { DataCatalog, CatalogResultCache, AnonymizationMode } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

export function CatalogAnonymizationTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
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

  return (
    <div className="space-y-4">
      {/* Threshold + Mode control */}
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('data_catalog.anon_threshold_title')}</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('data_catalog.anon_threshold_description')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Label className="text-xs">{t('data_catalog.threshold')}</Label>
          <Input
            type="number"
            min={0}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            className="w-24"
          />
          <Label className="text-xs">{t('data_catalog.anon_mode')}</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as AnonymizationMode)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="replace">{t('data_catalog.anon_mode_replace')}</SelectItem>
              <SelectItem value="suppress">{t('data_catalog.anon_mode_suppress')}</SelectItem>
            </SelectContent>
          </Select>
          {isDirty && (
            <Button size="sm" onClick={handleSave}>
              {t('common.save')}
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {mode === 'replace'
            ? t('data_catalog.anon_replace_hint', { threshold: previewThreshold })
            : t('data_catalog.anon_suppress_hint')
          }
        </p>
      </Card>

      {/* Impact summary */}
      <div className="grid grid-cols-4 gap-3">
        <Card className="p-3 text-center">
          <div className="flex items-center justify-center gap-1.5">
            {mode === 'replace' ? <Replace size={14} className="text-amber-500" /> : <EyeOff size={14} className="text-red-500" />}
            <p className="text-2xl font-bold">{impact.affectedRows.toLocaleString()}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === 'replace' ? t('data_catalog.anon_replaced_rows') : t('data_catalog.anon_suppressed_rows')}
          </p>
          <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">{impact.affectedPct}%</p>
        </Card>
        <Card className="p-3 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <Eye size={14} className="text-green-500" />
            <p className="text-2xl font-bold">{impact.unaffectedRows.toLocaleString()}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('data_catalog.anon_retained_rows')}</p>
          <p className="mt-1 text-xs font-medium text-green-600 dark:text-green-400">{impact.unaffectedPct}%</p>
        </Card>
        <Card className="p-3 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <AlertTriangle size={14} className="text-amber-500" />
            <p className="text-2xl font-bold">{mode === 'suppress' ? impact.lostConcepts.toLocaleString() : impact.partialConcepts.toLocaleString()}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === 'suppress' ? t('data_catalog.anon_lost_concepts') : t('data_catalog.anon_partial_concepts')}
          </p>
          <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">{impact.partialPct}%</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold">{impact.retainedPct}%</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.anon_retained_pct')}</p>
          <Progress value={impact.retainedPct} className="mt-2 h-1.5" />
        </Card>
      </div>

      {/* Detail breakdown */}
      <Card className="p-4">
        <div className="grid grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-xs text-muted-foreground">{t('data_catalog.anon_total_rows')}</span>
            <p className="font-medium">{impact.totalRows.toLocaleString()}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">{t('data_catalog.anon_total_concepts')}</span>
            <p className="font-medium">{impact.totalConcepts.toLocaleString()}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">{t('data_catalog.anon_partial_concepts')}</span>
            <p className="font-medium">{impact.partialConcepts.toLocaleString()} ({impact.partialPct}%)</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">{t('data_catalog.anon_lost_concepts')}</span>
            <p className="font-medium">{impact.lostConcepts.toLocaleString()}</p>
          </div>
        </div>
      </Card>
    </div>
  )
}
