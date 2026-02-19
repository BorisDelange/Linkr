import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Eye, EyeOff, AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useCatalogStore } from '@/stores/catalog-store'
import type { DataCatalog, CatalogResultCache } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

export function CatalogAnonymizationTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const { updateCatalog } = useCatalogStore()
  const [thresholdInput, setThresholdInput] = useState(String(catalog.anonymization.threshold))

  const previewThreshold = Math.max(0, parseInt(thresholdInput) || 0)
  const isDirty = previewThreshold !== catalog.anonymization.threshold

  // Compute anonymization impact
  const impact = useMemo(() => {
    const retained = cache.rows.filter((r) => r.patientCount >= previewThreshold)
    const suppressed = cache.rows.filter((r) => r.patientCount < previewThreshold)

    // Unique concepts across all rows
    const allConceptIds = new Set(cache.rows.map((r) => r.conceptId))
    const retainedConceptIds = new Set(retained.map((r) => r.conceptId))
    const suppressedConceptIds = new Set(
      [...allConceptIds].filter((id) => !retainedConceptIds.has(id)),
    )
    const partiallyConceptIds = new Set(
      suppressed
        .map((r) => r.conceptId)
        .filter((id) => retainedConceptIds.has(id)),
    )

    return {
      totalRows: cache.rows.length,
      retainedRows: retained.length,
      suppressedRows: suppressed.length,
      totalConcepts: allConceptIds.size,
      retainedConcepts: retainedConceptIds.size,
      lostConcepts: suppressedConceptIds.size,
      partialConcepts: partiallyConceptIds.size,
      retainedPct: cache.rows.length > 0
        ? Math.round((retained.length / cache.rows.length) * 100)
        : 100,
    }
  }, [cache.rows, previewThreshold])

  const handleSave = async () => {
    await updateCatalog(catalog.id, {
      anonymization: { ...catalog.anonymization, threshold: previewThreshold },
    })
  }

  return (
    <div className="space-y-4">
      {/* Threshold control */}
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('data_catalog.anon_threshold_title')}</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('data_catalog.anon_threshold_description')}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Label className="text-xs">{t('data_catalog.threshold')}</Label>
          <Input
            type="number"
            min={0}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            className="w-24"
          />
          <span className="text-xs text-muted-foreground">{t('data_catalog.threshold_hint')}</span>
          {isDirty && (
            <Button size="sm" onClick={handleSave}>
              {t('common.save')}
            </Button>
          )}
        </div>
      </Card>

      {/* Impact summary */}
      <div className="grid grid-cols-4 gap-3">
        <Card className="p-3 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <Eye size={14} className="text-green-500" />
            <p className="text-2xl font-bold">{impact.retainedRows.toLocaleString()}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('data_catalog.anon_retained_rows')}</p>
        </Card>
        <Card className="p-3 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <EyeOff size={14} className="text-red-500" />
            <p className="text-2xl font-bold">{impact.suppressedRows.toLocaleString()}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('data_catalog.anon_suppressed_rows')}</p>
        </Card>
        <Card className="p-3 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <AlertTriangle size={14} className="text-amber-500" />
            <p className="text-2xl font-bold">{impact.lostConcepts.toLocaleString()}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('data_catalog.anon_lost_concepts')}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold">{impact.retainedPct}%</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.anon_retained_pct')}</p>
          <Progress value={impact.retainedPct} className="mt-2 h-1.5" />
        </Card>
      </div>

      {/* Detail breakdown */}
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-4 text-sm">
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
            <p className="font-medium">{impact.partialConcepts.toLocaleString()}</p>
          </div>
        </div>
      </Card>
    </div>
  )
}
