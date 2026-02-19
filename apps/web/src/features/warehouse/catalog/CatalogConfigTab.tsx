import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Loader2, Users, Calendar, MapPin, Clock, Tag, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
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
import type { ComputeProgress } from '@/lib/duckdb/catalog-compute'
import type { DataCatalog, DimensionConfig } from '@/types'
import { AGE_BRACKET_PRESETS } from '@/types/catalog'

/** Map each compute step to a [start, end] percentage range (0–100). */
const STEP_RANGES: Record<string, [number, number]> = {
  mounting: [0, 5],
  building: [5, 10],
  executing: [10, 85],
  processing: [85, 95],
  saving: [95, 100],
}

function computeProgressPercent(progress: ComputeProgress): number {
  const range = STEP_RANGES[progress.step]
  if (!range) return 0
  return range[0] + (range[1] - range[0]) * progress.fraction
}

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
  const { updateCatalog, computeRunning, computeProgress, startCompute, setComputeProgress, finishCompute, failCompute, serviceMappings } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const dataSource = dataSources.find((ds) => ds.id === catalog.dataSourceId)

  const ageDim = catalog.dimensions.find((d) => d.type === 'age_group')
  const currentBrackets = ageDim?.ageGroup?.brackets ?? [10, 20, 30, 40, 50, 60, 70, 80, 90]
  const [bracketInput, setBracketInput] = useState('')

  // Detect which preset matches current brackets (if any)
  const activePreset = useMemo(() => {
    const json = JSON.stringify(currentBrackets)
    for (const [key, brackets] of Object.entries(AGE_BRACKET_PRESETS)) {
      if (JSON.stringify(brackets) === json) return key
    }
    return null
  }, [currentBrackets])

  const handlePresetChange = async (presetKey: string) => {
    if (presetKey === '__custom__') return
    const brackets = AGE_BRACKET_PRESETS[presetKey]
    if (!brackets || !ageDim) return
    await handleDimensionConfigChange(ageDim.id, { ageGroup: { brackets } })
  }

  const handleAddBracket = async () => {
    const value = parseInt(bracketInput)
    if (isNaN(value) || value <= 0 || !ageDim) return
    if (currentBrackets.includes(value)) {
      setBracketInput('')
      return
    }
    const newBrackets = [...currentBrackets, value].sort((a, b) => a - b)
    setBracketInput('')
    await handleDimensionConfigChange(ageDim.id, { ageGroup: { brackets: newBrackets } })
  }

  const handleRemoveBracket = async (value: number) => {
    if (!ageDim) return
    const newBrackets = currentBrackets.filter((b) => b !== value)
    await handleDimensionConfigChange(ageDim.id, { ageGroup: { brackets: newBrackets } })
  }

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

  const handleCompute = async () => {
    if (!dataSource?.schemaMapping) return
    startCompute()
    try {
      await updateCatalog(catalog.id, { status: 'computing' })
      setComputeProgress({ step: 'mounting', fraction: 0 })
      await ensureMounted(catalog.dataSourceId)
      setComputeProgress({ step: 'mounting', fraction: 1 })
      const cache = await computeCatalog(
        catalog,
        catalog.dataSourceId,
        dataSource.schemaMapping,
        serviceMappings,
        (progress) => setComputeProgress(progress),
      )
      await updateCatalog(catalog.id, {
        status: 'success',
        lastError: undefined,
        lastComputedAt: cache.computedAt,
        lastComputeDurationMs: cache.durationMs,
      })
      finishCompute(cache)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('Catalog compute failed:', message)
      await updateCatalog(catalog.id, { status: 'error', lastError: message })
      failCompute()
    }
  }

  return (
    <div className="space-y-4">
      {/* Dimensions — 2-column grid */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold">{t('data_catalog.dimensions_title')}</h3>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {catalog.dimensions.map((dim) => {
            const Icon = DIMENSION_ICONS[dim.type] ?? Users
            return (
              <div
                key={dim.id}
                className="flex items-center gap-2.5 rounded-lg border px-3 py-2"
              >
                <Icon size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm">{t(`data_catalog.dim_${dim.type}`)}</span>

                {/* Inline config for non-age dimensions */}
                {dim.enabled && dim.type === 'admission_date' && (
                  <Select
                    value={dim.admissionDate?.step ?? 'month'}
                    onValueChange={(v) =>
                      handleDimensionConfigChange(dim.id, {
                        admissionDate: { step: v as 'day' | 'month' | 'year' },
                      })
                    }
                  >
                    <SelectTrigger className="h-7 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="day">{t('data_catalog.step_day')}</SelectItem>
                      <SelectItem value="month">{t('data_catalog.step_month')}</SelectItem>
                      <SelectItem value="year">{t('data_catalog.step_year')}</SelectItem>
                    </SelectContent>
                  </Select>
                )}

                {dim.enabled && dim.type === 'care_site' && (
                  <Select
                    value={dim.careSite?.level ?? 'visit_detail'}
                    onValueChange={(v) =>
                      handleDimensionConfigChange(dim.id, {
                        careSite: { ...dim.careSite, level: v as 'visit' | 'visit_detail' },
                      })
                    }
                  >
                    <SelectTrigger className="h-7 w-44 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="visit">{t('data_catalog.level_visit')}</SelectItem>
                      <SelectItem value="visit_detail">{t('data_catalog.level_visit_detail')}</SelectItem>
                    </SelectContent>
                  </Select>
                )}

                <Switch
                  checked={dim.enabled}
                  onCheckedChange={(v) => handleDimensionToggle(dim.id, v)}
                />
              </div>
            )
          })}
        </div>

        {/* Age bracket editor — shown when age_group is enabled */}
        {ageDim?.enabled && (
          <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 rounded-lg border p-4">
            {/* Left column: preset + add */}
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t('data_catalog.age_preset')}</Label>
                <Select
                  value={activePreset ?? '__custom__'}
                  onValueChange={handlePresetChange}
                >
                  <SelectTrigger className="mt-1 h-8 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(AGE_BRACKET_PRESETS).map((key) => (
                      <SelectItem key={key} value={key}>
                        {t(`data_catalog.age_preset_${key}`)}
                      </SelectItem>
                    ))}
                    {!activePreset && (
                      <SelectItem value="__custom__">{t('data_catalog.age_preset_custom')}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('data_catalog.age_add_bracket')}</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={bracketInput}
                    onChange={(e) => setBracketInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddBracket() }}
                    placeholder="e.g. 18"
                    className="h-8 w-28"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={handleAddBracket}
                    disabled={!bracketInput || isNaN(parseInt(bracketInput)) || parseInt(bracketInput) <= 0}
                  >
                    {t('common.add')}
                  </Button>
                </div>
              </div>
            </div>

            {/* Right column: badges on top, vertical lines, intervals below */}
            <div className="min-w-0 overflow-x-auto">
              <Label className="text-xs text-muted-foreground">{t('data_catalog.age_brackets')}</Label>
              {/* Row 1: badges */}
              {/* Row 2: vertical connectors + horizontal line */}
              {/* Row 3: interval labels */}
              {/* Badges with interval labels between them */}
              {(() => {
                const sorted = [...currentBrackets].sort((a, b) => a - b)
                const hasImplicitZero = sorted.length > 0 && sorted[0] > 0
                return (
                  <div className="mt-1.5 flex flex-wrap items-center">
                    {/* Implicit [0;first[ before first badge */}
                    {hasImplicitZero && (
                      <div className="flex items-center">
                        <span className="whitespace-nowrap px-1 text-[10px] text-muted-foreground">
                          [0;{sorted[0]}[
                        </span>
                        <div className="h-px w-2 bg-border" />
                      </div>
                    )}
                    {sorted.map((b, i) => (
                      <div key={b} className="flex items-center">
                        <Badge
                          variant="secondary"
                          className="group cursor-pointer gap-1 pr-1.5 text-xs hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleRemoveBracket(b)}
                        >
                          {b}
                          <X size={12} className="text-muted-foreground/50 group-hover:text-destructive" />
                        </Badge>
                        {/* Interval after this badge */}
                        <div className="flex items-center">
                          <div className="h-px w-2 bg-border" />
                          <span className="whitespace-nowrap px-1 text-[10px] text-muted-foreground">
                            {i < sorted.length - 1
                              ? `[${b};${sorted[i + 1]}[`
                              : `[${b};+∞[`}
                          </span>
                          {i < sorted.length - 1 && <div className="h-px w-2 bg-border" />}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          </div>
        )}
      </Card>

      {/* Concept classification */}
      {availableExtraColumns.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <Tag size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t('data_catalog.classification_title')}</h3>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">{t('data_catalog.category_column')}</Label>
              <Select
                value={catalog.categoryColumn ?? '__none__'}
                onValueChange={handleCategoryChange}
              >
                <SelectTrigger className="mt-1">
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
                <SelectTrigger className="mt-1">
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

      {/* Compute button + progress */}
      <div className="space-y-2">
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
          {!computeRunning && catalog.lastComputedAt && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock size={12} />
              {t('data_catalog.last_computed')}: {new Date(catalog.lastComputedAt).toLocaleString()}
              {catalog.lastComputeDurationMs != null && ` (${(catalog.lastComputeDurationMs / 1000).toFixed(1)}s)`}
            </span>
          )}
        </div>
        {computeRunning && computeProgress && (
          <div className="space-y-1">
            <Progress value={computeProgressPercent(computeProgress)} className="h-1.5" />
            <p className="text-xs text-muted-foreground">
              {t(`data_catalog.step_${computeProgress.step}`)}
              {computeProgress.detail && <span className="ml-1 text-muted-foreground/60">({computeProgress.detail})</span>}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
