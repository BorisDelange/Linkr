import { useTranslation } from 'react-i18next'
import { Play, Loader2, Users, Calendar, MapPin, Clock, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { computeCatalog } from '@/lib/duckdb/catalog-compute'
import type { DataCatalog, DimensionConfig } from '@/types'

interface Props {
  catalog: DataCatalog
}

const DIMENSION_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  age_group: Users,
  sex: Users,
  admission_date: Calendar,
  care_site: MapPin,
}

export function CatalogConfigTab({ catalog }: Props) {
  const { t } = useTranslation()
  const { updateCatalog, computeRunning, startCompute, finishCompute, failCompute, serviceMappings } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const dataSource = dataSources.find((ds) => ds.id === catalog.dataSourceId)

  // Collect available extraColumn keys across all concept dictionaries
  const availableExtraColumns: string[] = (() => {
    const keys = new Set<string>()
    const dicts = dataSource?.schemaMapping?.conceptTables ?? []
    for (const d of dicts) {
      if (d.extraColumns) {
        for (const key of Object.keys(d.extraColumns)) keys.add(key)
      }
    }
    return Array.from(keys).sort()
  })()

  const handleCategoryChange = async (value: string) => {
    const col = value === '__none__' ? undefined : value
    // If subcategory was the same, clear it
    const sub = catalog.subcategoryColumn === col ? undefined : catalog.subcategoryColumn
    await updateCatalog(catalog.id, { categoryColumn: col, subcategoryColumn: sub })
  }

  const handleSubcategoryChange = async (value: string) => {
    const col = value === '__none__' ? undefined : value
    await updateCatalog(catalog.id, { subcategoryColumn: col })
  }

  const handleDimensionToggle = async (dimId: string, enabled: boolean) => {
    const newDims = catalog.dimensions.map((d) =>
      d.id === dimId ? { ...d, enabled } : d,
    )
    await updateCatalog(catalog.id, { dimensions: newDims })
  }

  const handleDimensionConfigChange = async (dimId: string, changes: Partial<DimensionConfig>) => {
    const newDims = catalog.dimensions.map((d) =>
      d.id === dimId ? { ...d, ...changes } : d,
    )
    await updateCatalog(catalog.id, { dimensions: newDims })
  }

  const handleThresholdChange = async (value: string) => {
    const threshold = Math.max(0, parseInt(value) || 0)
    await updateCatalog(catalog.id, { anonymization: { ...catalog.anonymization, threshold } })
  }

  const handleCompute = async () => {
    if (!dataSource?.schemaMapping) return
    startCompute()
    try {
      await updateCatalog(catalog.id, { status: 'computing' })
      const cache = await computeCatalog(
        catalog,
        catalog.dataSourceId,
        dataSource.schemaMapping,
        serviceMappings,
      )
      await updateCatalog(catalog.id, {
        status: 'ready',
        lastComputedAt: cache.computedAt,
        lastComputeDurationMs: cache.durationMs,
      })
      finishCompute(cache)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('Catalog compute failed:', message)
      await updateCatalog(catalog.id, { status: 'error' })
      failCompute()
    }
  }

  return (
    <div className="space-y-6">
      {/* Dimensions */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold">{t('data_catalog.dimensions_title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('data_catalog.dimensions_description')}</p>

        <div className="mt-4 space-y-3">
          {catalog.dimensions.map((dim) => {
            const Icon = DIMENSION_ICONS[dim.type] ?? Users
            return (
              <div
                key={dim.id}
                className="flex items-start gap-3 rounded-lg border p-3"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon size={16} className="text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{t(`data_catalog.dim_${dim.type}`)}</span>
                    <Switch
                      checked={dim.enabled}
                      onCheckedChange={(v) => handleDimensionToggle(dim.id, v)}
                    />
                  </div>

                  {/* Per-type config */}
                  {dim.enabled && dim.type === 'age_group' && (
                    <div className="mt-2">
                      <Label className="text-xs text-muted-foreground">{t('data_catalog.age_step')}</Label>
                      <Select
                        value={String(dim.ageGroup?.step ?? 10)}
                        onValueChange={(v) =>
                          handleDimensionConfigChange(dim.id, { ageGroup: { step: Number(v) as 1 | 5 | 10 } })
                        }
                      >
                        <SelectTrigger className="mt-1 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 {t('data_catalog.years')}</SelectItem>
                          <SelectItem value="5">5 {t('data_catalog.years')}</SelectItem>
                          <SelectItem value="10">10 {t('data_catalog.years')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {dim.enabled && dim.type === 'admission_date' && (
                    <div className="mt-2">
                      <Label className="text-xs text-muted-foreground">{t('data_catalog.date_step')}</Label>
                      <Select
                        value={dim.admissionDate?.step ?? 'month'}
                        onValueChange={(v) =>
                          handleDimensionConfigChange(dim.id, {
                            admissionDate: { step: v as 'day' | 'month' | 'year' },
                          })
                        }
                      >
                        <SelectTrigger className="mt-1 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="day">{t('data_catalog.step_day')}</SelectItem>
                          <SelectItem value="month">{t('data_catalog.step_month')}</SelectItem>
                          <SelectItem value="year">{t('data_catalog.step_year')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {dim.enabled && dim.type === 'care_site' && (
                    <div className="mt-2">
                      <Label className="text-xs text-muted-foreground">{t('data_catalog.care_site_level')}</Label>
                      <Select
                        value={dim.careSite?.level ?? 'visit_detail'}
                        onValueChange={(v) =>
                          handleDimensionConfigChange(dim.id, {
                            careSite: { ...dim.careSite, level: v as 'visit' | 'visit_detail' },
                          })
                        }
                      >
                        <SelectTrigger className="mt-1 w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="visit">{t('data_catalog.level_visit')}</SelectItem>
                          <SelectItem value="visit_detail">{t('data_catalog.level_visit_detail')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* Concept classification */}
      {availableExtraColumns.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <Tag size={16} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t('data_catalog.classification_title')}</h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('data_catalog.classification_description')}</p>

          <div className="mt-4 flex flex-wrap gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">{t('data_catalog.category_column')}</Label>
              <Select
                value={catalog.categoryColumn ?? '__none__'}
                onValueChange={handleCategoryChange}
              >
                <SelectTrigger className="mt-1 w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('data_catalog.none')}</SelectItem>
                  {availableExtraColumns.map((key) => (
                    <SelectItem key={key} value={key}>{key}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">{t('data_catalog.subcategory_column')}</Label>
              <Select
                value={catalog.subcategoryColumn ?? '__none__'}
                onValueChange={handleSubcategoryChange}
              >
                <SelectTrigger className="mt-1 w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('data_catalog.none')}</SelectItem>
                  {availableExtraColumns
                    .filter((key) => key !== catalog.categoryColumn)
                    .map((key) => (
                      <SelectItem key={key} value={key}>{key}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>
      )}

      {/* Anonymization */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold">{t('data_catalog.anonymization_title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('data_catalog.anonymization_description')}</p>
        <div className="mt-3 flex items-center gap-3">
          <Label className="text-xs">{t('data_catalog.threshold')}</Label>
          <Input
            type="number"
            min={0}
            value={catalog.anonymization.threshold}
            onChange={(e) => handleThresholdChange(e.target.value)}
            className="w-24"
          />
          <span className="text-xs text-muted-foreground">{t('data_catalog.threshold_hint')}</span>
        </div>
      </Card>

      {/* Compute button */}
      <div className="flex items-center gap-3">
        <Button onClick={handleCompute} disabled={computeRunning || !dataSource?.schemaMapping}>
          {computeRunning ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t('data_catalog.computing')}
            </>
          ) : (
            <>
              <Play size={16} />
              {t('data_catalog.compute')}
            </>
          )}
        </Button>
        {catalog.lastComputedAt && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock size={12} />
            {t('data_catalog.last_computed')}: {new Date(catalog.lastComputedAt).toLocaleString()}
            {catalog.lastComputeDurationMs != null && ` (${(catalog.lastComputeDurationMs / 1000).toFixed(1)}s)`}
          </span>
        )}
      </div>
    </div>
  )
}
