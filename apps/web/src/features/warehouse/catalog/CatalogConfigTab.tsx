import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Loader2, Users, Clock, Tag, X, Calendar, Check, ChevronDown, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildCategoryLabelsQuery, buildServiceLabelsQuery } from '@/lib/duckdb/catalog-queries'
import { computeCatalog } from '@/lib/duckdb/catalog-compute'
import type { ComputeProgress } from '@/lib/duckdb/catalog-compute'
import type { DataCatalog, DimensionConfig, PeriodConfig } from '@/types'
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

// ── Multi-select dropdown ─────────────────────────────────────

interface MultiSelectProps {
  label: string
  values: string[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
}

function MultiSelect({ label, values, selected, onChange, placeholder }: MultiSelectProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const selectedSet = new Set(selected)

  const filtered = search.trim()
    ? values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : values

  const toggle = (val: string) => {
    if (selectedSet.has(val)) onChange(selected.filter((s) => s !== val))
    else onChange([...selected, val])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full justify-between gap-1 text-xs font-normal"
        >
          <span className="min-w-0 truncate text-left">
            {selected.length > 0
              ? `${selected.length} ${label.toLowerCase()}`
              : (placeholder ?? label)}
          </span>
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0" onCloseAutoFocus={(e) => e.preventDefault()}>
        {values.length > 6 && (
          <div className="border-b p-2">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('data_catalog.search_filter_values')}
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
        )}
        <div className="max-h-56 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t('data_catalog.no_results')}</p>
          ) : (
            filtered.map((val) => {
              const isSelected = selectedSet.has(val)
              return (
                <button
                  key={val}
                  onClick={() => toggle(val)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <div
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30'
                    }`}
                  >
                    {isSelected && <Check size={9} />}
                  </div>
                  <span className="min-w-0 truncate">{val}</span>
                </button>
              )
            })
          )}
        </div>
        {selected.length > 0 && (
          <div className="border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => onChange([])}
            >
              {t('data_catalog.clear_filter')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── Main component ────────────────────────────────────────────

export function CatalogConfigTab({ catalog }: Props) {
  const { t } = useTranslation()
  const { updateCatalog, computeRunning, computeProgress, startCompute, setComputeProgress, finishCompute, failCompute } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const dataSource = dataSources.find((ds) => ds.id === catalog.dataSourceId)

  // --- Age bracket state ---
  const ageDim = catalog.dimensions.find((d) => d.type === 'age_group')
  const currentBrackets = ageDim?.ageGroup?.brackets ?? [10, 20, 30, 40, 50, 60, 70, 80, 90]
  const [bracketInput, setBracketInput] = useState('')

  const activePreset = useMemo(() => {
    const json = JSON.stringify(currentBrackets)
    for (const [key, brackets] of Object.entries(AGE_BRACKET_PRESETS)) {
      if (JSON.stringify(brackets) === json) return key
    }
    return null
  }, [currentBrackets])

  // --- Available columns for concept classification ---
  // Collect from dict.categoryColumn, dict.subcategoryColumn, and extraColumns keys
  const availableExtraColumns: string[] = (() => {
    const keys = new Set<string>()
    const dicts = dataSource?.schemaMapping?.conceptTables ?? []
    for (const d of dicts) {
      if (d.categoryColumn) keys.add(d.categoryColumn)
      if (d.subcategoryColumn) keys.add(d.subcategoryColumn)
      if (d.extraColumns) {
        for (const key of Object.keys(d.extraColumns)) keys.add(key)
      }
    }
    return Array.from(keys).sort()
  })()

  // --- Period config ---
  const periodConfig = catalog.periodConfig
  const [availableCategoryValues, setAvailableCategoryValues] = useState<string[]>([])
  const [availableServiceLabels, setAvailableServiceLabels] = useState<string[]>([])

  // Load distinct category values (ensure data source is mounted first)
  useEffect(() => {
    if (!catalog.categoryColumn || !dataSource?.schemaMapping) {
      setAvailableCategoryValues([])
      return
    }
    const sql = buildCategoryLabelsQuery(dataSource.schemaMapping, catalog.categoryColumn)
    if (!sql) { setAvailableCategoryValues([]); return }
    let cancelled = false
    ensureMounted(catalog.dataSourceId)
      .then(() => queryDataSource(catalog.dataSourceId, sql))
      .then((rows) => { if (!cancelled) setAvailableCategoryValues(rows.map((r) => String(r.cat_label)).filter(Boolean)) })
      .catch(() => { if (!cancelled) setAvailableCategoryValues([]) })
    return () => { cancelled = true }
  }, [catalog.categoryColumn, catalog.dataSourceId, dataSource?.schemaMapping, ensureMounted])

  // Load distinct service labels when service config changes (ensure data source is mounted first)
  useEffect(() => {
    if (!periodConfig || !dataSource?.schemaMapping) {
      setAvailableServiceLabels([])
      return
    }
    const sql = buildServiceLabelsQuery(dataSource.schemaMapping, periodConfig.serviceLevel)
    if (!sql) { setAvailableServiceLabels([]); return }
    let cancelled = false
    ensureMounted(catalog.dataSourceId)
      .then(() => queryDataSource(catalog.dataSourceId, sql))
      .then((rows) => { if (!cancelled) setAvailableServiceLabels(rows.map((r) => String(r.svc_label)).filter(Boolean)) })
      .catch(() => { if (!cancelled) setAvailableServiceLabels([]) })
    return () => { cancelled = true }
  }, [periodConfig?.serviceLevel, catalog.dataSourceId, dataSource?.schemaMapping, ensureMounted])

  const hasVisitServiceColumn = !!dataSource?.schemaMapping?.visitTable?.typeColumn
  const hasVisitDetailServiceColumn = !!dataSource?.schemaMapping?.visitDetailTable?.unitColumn

  // --- Dimension helpers ---
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

  // --- Period helpers ---
  const handlePeriodConfigChange = async (changes: Partial<PeriodConfig>) => {
    const current = catalog.periodConfig ?? { granularity: 'month', serviceLevel: 'visit' }
    await updateCatalog(catalog.id, { periodConfig: { ...current, ...changes } })
  }

  const handlePeriodEnable = async (enabled: boolean) => {
    if (enabled) {
      // Enable period + sync admission_date dimension
      const newDims = catalog.dimensions.map((d) =>
        d.id === 'admission_date' ? { ...d, enabled: true, admissionDate: { step: 'month' as const } } : d,
      )
      await updateCatalog(catalog.id, {
        periodConfig: { granularity: 'month', serviceLevel: 'visit' },
        dimensions: newDims,
      })
    } else {
      // Disable period + admission_date dimension
      const newDims = catalog.dimensions.map((d) =>
        d.id === 'admission_date' ? { ...d, enabled: false } : d,
      )
      await updateCatalog(catalog.id, { periodConfig: undefined, dimensions: newDims })
    }
  }

  const handleGranularityChange = async (gran: 'month' | 'quarter' | 'year') => {
    // Sync admission_date dimension step with period granularity
    const newDims = catalog.dimensions.map((d) =>
      d.id === 'admission_date' ? { ...d, admissionDate: { step: gran } } : d,
    )
    await updateCatalog(catalog.id, {
      periodConfig: { ...catalog.periodConfig!, granularity: gran },
      dimensions: newDims,
    })
  }

  // --- Age bracket handlers ---
  const handlePresetChange = async (presetKey: string) => {
    if (presetKey === '__custom__') return
    const brackets = AGE_BRACKET_PRESETS[presetKey]
    if (!brackets || !ageDim) return
    await handleDimensionConfigChange(ageDim.id, { ageGroup: { brackets } })
  }

  const handleAddBracket = async () => {
    const value = parseInt(bracketInput)
    if (isNaN(value) || value <= 0 || !ageDim) return
    if (currentBrackets.includes(value)) { setBracketInput(''); return }
    const newBrackets = [...currentBrackets, value].sort((a, b) => a - b)
    setBracketInput('')
    await handleDimensionConfigChange(ageDim.id, { ageGroup: { brackets: newBrackets } })
  }

  const handleRemoveBracket = async (value: number) => {
    if (!ageDim) return
    const newBrackets = currentBrackets.filter((b) => b !== value)
    await handleDimensionConfigChange(ageDim.id, { ageGroup: { brackets: newBrackets } })
  }

  // --- Classification handlers ---
  const handleCategoryChange = async (value: string) => {
    const col = value === '__none__' ? undefined : value
    const sub = catalog.subcategoryColumn === col ? undefined : catalog.subcategoryColumn
    await updateCatalog(catalog.id, { categoryColumn: col, subcategoryColumn: sub })
  }

  const handleSubcategoryChange = async (value: string) => {
    const col = value === '__none__' ? undefined : value
    await updateCatalog(catalog.id, { subcategoryColumn: col })
  }

  // --- Compute ---
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

  // Derived state
  const sexDim = catalog.dimensions.find((d) => d.type === 'sex')
  const careSiteDim = catalog.dimensions.find((d) => d.type === 'care_site')

  return (
    <div className="space-y-4">
      {/* Period — primary card */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t('data_catalog.period_config_title')}</h3>
          </div>
          <Switch checked={!!periodConfig} onCheckedChange={handlePeriodEnable} />
        </div>

        {periodConfig && (
          <div className="mt-3 space-y-4">
            {/* Granularity */}
            <div>
              <Label className="text-xs text-muted-foreground">{t('data_catalog.period_granularity')}</Label>
              <Select
                value={periodConfig.granularity}
                onValueChange={(v) => handleGranularityChange(v as 'month' | 'quarter' | 'year')}
              >
                <SelectTrigger className="mt-1 h-8 w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">{t('data_catalog.period_granularity_month')}</SelectItem>
                  <SelectItem value="quarter">{t('data_catalog.period_granularity_quarter')}</SelectItem>
                  <SelectItem value="year">{t('data_catalog.period_granularity_year')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Enrichments — each is a toggleable sub-section */}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">{t('data_catalog.period_enrichments')}</Label>

              {/* Sex */}
              <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Users size={14} className="text-muted-foreground" />
                  <span className="text-sm">{t('data_catalog.dim_sex')}</span>
                </div>
                <Switch
                  checked={sexDim?.enabled ?? false}
                  onCheckedChange={(v) => sexDim && handleDimensionToggle(sexDim.id, v)}
                />
              </div>

              {/* Age group */}
              <div className="rounded-lg border">
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Users size={14} className="text-muted-foreground" />
                    <span className="text-sm">{t('data_catalog.dim_age_group')}</span>
                  </div>
                  <Switch
                    checked={ageDim?.enabled ?? false}
                    onCheckedChange={(v) => ageDim && handleDimensionToggle(ageDim.id, v)}
                  />
                </div>
                {ageDim?.enabled && (
                  <div className="border-t px-3 py-3">
                    <div className="grid grid-cols-[auto_1fr] gap-x-6">
                      {/* Left: preset + add */}
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
                      {/* Right: bracket badges */}
                      <div className="min-w-0 overflow-x-auto">
                        <Label className="text-xs text-muted-foreground">{t('data_catalog.age_brackets')}</Label>
                        {(() => {
                          const sorted = [...currentBrackets].sort((a, b) => a - b)
                          const hasImplicitZero = sorted.length > 0 && sorted[0] > 0
                          return (
                            <div className="mt-1.5 flex flex-wrap items-center">
                              {hasImplicitZero && (
                                <div className="flex items-center">
                                  <span className="whitespace-nowrap px-1 text-[10px] text-muted-foreground">[0;{sorted[0]}[</span>
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
                                  <div className="flex items-center">
                                    <div className="h-px w-2 bg-border" />
                                    <span className="whitespace-nowrap px-1 text-[10px] text-muted-foreground">
                                      {i < sorted.length - 1 ? `[${b};${sorted[i + 1]}[` : `[${b};+∞[`}
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
                  </div>
                )}
              </div>

              {/* Services */}
              <div className="rounded-lg border">
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{t('data_catalog.period_services')}</span>
                  </div>
                  <Switch
                    checked={careSiteDim?.enabled ?? false}
                    onCheckedChange={(v) => {
                      if (careSiteDim) handleDimensionToggle(careSiteDim.id, v)
                    }}
                  />
                </div>
                {careSiteDim?.enabled && (
                  <div className="space-y-2 border-t px-3 py-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">{t('data_catalog.period_service_level')}</Label>
                      <Select
                        value={periodConfig.serviceLevel}
                        onValueChange={(v) => {
                          const level = v as 'visit' | 'visit_detail'
                          handlePeriodConfigChange({ serviceLevel: level })
                          handleDimensionConfigChange(careSiteDim.id, {
                            careSite: { ...careSiteDim.careSite, level },
                          })
                        }}
                      >
                        <SelectTrigger className="mt-1 h-8 w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="visit" disabled={!hasVisitServiceColumn}>
                            {t('data_catalog.level_visit')}{!hasVisitServiceColumn ? ` (${t('data_catalog.no_type_column')})` : ''}
                          </SelectItem>
                          <SelectItem value="visit_detail" disabled={!hasVisitDetailServiceColumn}>
                            {t('data_catalog.level_visit_detail')}{!hasVisitDetailServiceColumn ? ` (${t('data_catalog.no_unit_column')})` : ''}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {/* Service multi-select (optional filter — only for visit_detail level) */}
                    {periodConfig.serviceLevel === 'visit_detail' && availableServiceLabels.length > 0 && (
                      <div>
                        <Label className="text-xs text-muted-foreground">{t('data_catalog.period_services_select')}</Label>
                        <div className="mt-1">
                          <MultiSelect
                            label={t('data_catalog.period_services')}
                            values={availableServiceLabels}
                            selected={periodConfig.serviceLabels ?? []}
                            onChange={(vals) => handlePeriodConfigChange({ serviceLabels: vals.length > 0 ? vals : undefined })}
                            placeholder={t('data_catalog.period_all_services')}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Concept categories */}
              {catalog.categoryColumn && (
                <div className="rounded-lg border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Tag size={14} className="text-muted-foreground" />
                    <span className="text-sm">{t('data_catalog.period_concept_categories')}</span>
                  </div>
                  {availableCategoryValues.length > 0 ? (
                    <div className="mt-2">
                      <MultiSelect
                        label={t('data_catalog.period_concept_categories')}
                        values={availableCategoryValues}
                        selected={periodConfig.conceptCategories ?? []}
                        onChange={(vals) => handlePeriodConfigChange({ conceptCategories: vals })}
                        placeholder={t('data_catalog.period_no_categories_selected')}
                      />
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">{t('data_catalog.period_no_categories')}</p>
                  )}
                </div>
              )}
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
