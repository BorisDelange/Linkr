import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Calendar, Info, Loader2, Pause, Play, RotateCcw, Tag, Trash2, Users, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { MULTI_SELECT_FORM_TRIGGER, MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildCategoryLabelsQuery, buildServiceLabelsQuery } from '@/lib/duckdb/catalog-queries'
import {
  clearCatalogRunError,
  getCatalogRunSnapshot,
  pauseCatalogRun,
  startCatalogRun,
  watchCatalogRun,
  type CatalogRunSnapshot,
} from '@/lib/duckdb/catalog-runner'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { cn } from '@/lib/utils'
import type { CatalogResultCache, DataCatalog, DimensionConfig, PeriodConfig } from '@/types'
import { AGE_BRACKET_PRESETS } from '@/types/catalog'

interface Props {
  catalog: DataCatalog
}

/**
 * Configure what the catalog counts, then compute it — resumably.
 *
 * Laid out like the mapping project's source-concepts panel, and for the same
 * reason: both are "set the terms of a long database walk, then watch it", so
 * they read as one screen rather than two conventions. The run itself lives in a
 * module-level registry (`catalog-runner`), so leaving the tab does not abandon
 * a computation that takes minutes to hours.
 */
export function CatalogConfigTab({ catalog }: Props) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('catalog:write')
  const { updateCatalog, setResultCache } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const dataSource = dataSources.find((ds) => ds.id === catalog.dataSourceId)
  const mapping = dataSource?.schemaMapping

  // The run lives in the registry, not here: leaving the tab must not stop a
  // computation that takes hours. This only mirrors what the run reports —
  // including a run this component never started.
  const [snapshot, setSnapshot] = useState<CatalogRunSnapshot>(() => getCatalogRunSnapshot(catalog.id))
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  useEffect(() => {
    setSnapshot(getCatalogRunSnapshot(catalog.id))
    return watchCatalogRun(catalog.id, setSnapshot)
  }, [catalog.id])

  const { running, error, phase } = snapshot
  // Neither phase has an offset to show: both precede the first period row.
  const preparing = phase === 'mounting' || phase === 'concepts'

  // --- Age bracket state ---
  const ageDim = catalog.dimensions.find((d) => d.type === 'age_group')
  const currentBrackets = useMemo(
    () => ageDim?.ageGroup?.brackets ?? [10, 20, 30, 40, 50, 60, 70, 80, 90],
    [ageDim],
  )
  const [bracketInput, setBracketInput] = useState('')

  const activePreset = useMemo(() => {
    const json = JSON.stringify(currentBrackets)
    for (const [key, brackets] of Object.entries(AGE_BRACKET_PRESETS)) {
      if (JSON.stringify(brackets) === json) return key
    }
    return null
  }, [currentBrackets])

  // --- Available columns for concept classification ---
  // Collected from dict.categoryColumn, dict.subcategoryColumn and extraColumns keys.
  const availableExtraColumns = useMemo(() => {
    const keys = new Set<string>()
    for (const d of mapping?.conceptTables ?? []) {
      if (d.categoryColumn) keys.add(d.categoryColumn)
      if (d.subcategoryColumn) keys.add(d.subcategoryColumn)
      for (const key of Object.keys(d.extraColumns ?? {})) keys.add(key)
    }
    return [...keys].sort()
  }, [mapping])

  const periodConfig = catalog.periodConfig
  const [availableCategoryValues, setAvailableCategoryValues] = useState<string[]>([])
  const [availableServiceLabels, setAvailableServiceLabels] = useState<string[]>([])

  // Distinct category values (the data source has to be mounted first).
  useEffect(() => {
    if (!catalog.categoryColumn || !mapping) {
      setAvailableCategoryValues([])
      return
    }
    const sql = buildCategoryLabelsQuery(mapping, catalog.categoryColumn)
    if (!sql) { setAvailableCategoryValues([]); return }
    let cancelled = false
    ensureMounted(catalog.dataSourceId)
      .then(() => queryDataSource(catalog.dataSourceId, sql))
      .then((rows) => { if (!cancelled) setAvailableCategoryValues(rows.map((r) => String(r.cat_label)).filter(Boolean)) })
      .catch(() => { if (!cancelled) setAvailableCategoryValues([]) })
    return () => { cancelled = true }
  }, [catalog.categoryColumn, catalog.dataSourceId, mapping, ensureMounted])

  // Distinct service labels — always at visit_detail level.
  useEffect(() => {
    if (!periodConfig || !mapping) {
      setAvailableServiceLabels([])
      return
    }
    const sql = buildServiceLabelsQuery(mapping, 'visit_detail')
    if (!sql) { setAvailableServiceLabels([]); return }
    let cancelled = false
    ensureMounted(catalog.dataSourceId)
      .then(() => queryDataSource(catalog.dataSourceId, sql))
      .then((rows) => { if (!cancelled) setAvailableServiceLabels(rows.map((r) => String(r.svc_label)).filter(Boolean)) })
      .catch(() => { if (!cancelled) setAvailableServiceLabels([]) })
    return () => { cancelled = true }
  }, [periodConfig, catalog.dataSourceId, mapping, ensureMounted])

  // --- Config writers ---
  const setDimension = async (dimId: string, changes: Partial<DimensionConfig>) => {
    await updateCatalog(catalog.id, {
      dimensions: catalog.dimensions.map((d) => (d.id === dimId ? { ...d, ...changes } : d)),
    })
  }

  const setPeriod = async (changes: Partial<PeriodConfig>) => {
    const current = catalog.periodConfig ?? { granularity: 'month' as const, serviceLevel: 'visit_detail' as const }
    await updateCatalog(catalog.id, { periodConfig: { ...current, ...changes } })
  }

  const togglePeriod = async (enabled: boolean) => {
    // The admission_date dimension IS the period axis, so the two move together.
    const dimensions = catalog.dimensions.map((d) =>
      d.id === 'admission_date'
        ? { ...d, enabled, ...(enabled ? { admissionDate: { step: 'month' as const } } : {}) }
        : d,
    )
    await updateCatalog(catalog.id, {
      periodConfig: enabled ? { granularity: 'month', serviceLevel: 'visit_detail' } : undefined,
      dimensions,
    })
  }

  const setGranularity = async (granularity: 'month' | 'quarter' | 'year') => {
    // AdmissionDateConfig.step has no 'quarter' (buildAdmissionDateExpr can't
    // express it), so the dimension follows at the nearest step it can hold.
    const step: 'month' | 'year' = granularity === 'year' ? 'year' : 'month'
    await updateCatalog(catalog.id, {
      periodConfig: { ...catalog.periodConfig!, granularity },
      dimensions: catalog.dimensions.map((d) =>
        d.id === 'admission_date' ? { ...d, admissionDate: { step } } : d,
      ),
    })
  }

  const addBracket = async () => {
    const value = parseInt(bracketInput)
    if (isNaN(value) || value <= 0 || !ageDim) return
    setBracketInput('')
    if (currentBrackets.includes(value)) return
    await setDimension(ageDim.id, { ageGroup: { brackets: [...currentBrackets, value].sort((a, b) => a - b) } })
  }

  const removeBracket = async (value: number) => {
    if (!ageDim) return
    await setDimension(ageDim.id, { ageGroup: { brackets: currentBrackets.filter((b) => b !== value) } })
  }

  const setCategoryColumn = async (value: string) => {
    const col = value === '__none__' ? undefined : value
    await updateCatalog(catalog.id, {
      categoryColumn: col,
      // A column cannot be both; picking it as the category frees the other slot.
      subcategoryColumn: catalog.subcategoryColumn === col ? undefined : catalog.subcategoryColumn,
    })
  }

  // --- Run ---
  /**
   * Clearing a field takes an explicit null, never `undefined`.
   *
   * `JSON.stringify` drops an undefined value, and the API's `exclude_unset`
   * then reads the absent key as "no change" and keeps the old one — so a
   * finished run would stay marked paused and keep offering Resume.
   */
  const clearedCatalogPatch = (changes: Record<string, unknown>) =>
    changes as unknown as Partial<DataCatalog>

  const persist = useCallback(async (cache: CatalogResultCache, done: boolean) => {
    await getStorage().catalogResults.save(cache)
    setResultCache(cache)
    await updateCatalog(catalog.id, clearedCatalogPatch({
      status: done ? 'success' : 'computing',
      lastError: null,
      lastComputedAt: cache.computedAt,
      lastComputeDurationMs: cache.durationMs,
      // The resume offset: null once the walk is finished, so the panel stops
      // reading as paused.
      computedPeriods: done ? null : cache.periods?.length ?? 0,
    }))
  }, [catalog.id, setResultCache, updateCatalog])

  const run = useCallback(async (restart: boolean) => {
    if (!mapping || !dataSource) return
    clearCatalogRunError(catalog.id)
    // A resume needs the rows already computed; only a fresh cache is discarded.
    const stored = restart ? null : await getStorage().catalogResults.get(catalog.id)
    const offset = catalog.computedPeriods ?? null
    const resumeFrom = stored && offset != null ? { cache: stored, computed: offset } : null
    if (restart) await updateCatalog(catalog.id, clearedCatalogPatch({ computedPeriods: null }))

    startCatalogRun({
      catalog,
      mapping,
      ensureMounted: () => ensureMounted(catalog.dataSourceId).then(() => {}),
      query: (sql) => queryDataSource(catalog.dataSourceId, sql),
      resumeFrom,
      persist,
      persistError: async (message) => {
        await updateCatalog(catalog.id, { status: 'error', lastError: message })
      },
    })
  }, [catalog, mapping, dataSource, ensureMounted, persist, updateCatalog])

  /** Throw the computed results away, unlocking a fresh run. */
  const discard = useCallback(async () => {
    setConfirmDiscard(false)
    clearCatalogRunError(catalog.id)
    await getStorage().catalogResults.delete(catalog.id).catch(() => {})
    setResultCache(null)
    await updateCatalog(catalog.id, clearedCatalogPatch({
      status: 'draft',
      lastError: null,
      lastComputedAt: null,
      lastComputeDurationMs: null,
      computedPeriods: null,
    }))
    setSnapshot(getCatalogRunSnapshot(catalog.id))
  }, [catalog.id, setResultCache, updateCatalog])

  // `!= null` covers both: absent (never run) and an explicit null (finished).
  const savedOffset = catalog.computedPeriods ?? null
  const computed = snapshot.computed ?? savedOffset ?? 0
  const total = snapshot.total ?? 0
  const paused = !running && savedOffset != null
  const done = !running && !paused && catalog.status === 'success'
  const percent = total > 0 ? Math.min(100, Math.round((computed / total) * 100)) : 0

  const sexDim = catalog.dimensions.find((d) => d.type === 'sex')
  const careSiteDim = catalog.dimensions.find((d) => d.type === 'care_site')
  // The period axis is what the walk is chunked on; changing it mid-run would
  // make the stored offset an index into a different plan.
  const locked = running || paused

  return (
    // These delays govern the OPTION ROWS. Their tooltips explain the options
    // rather than merely labelling them, so they need a beat before the first one
    // appears — otherwise moving across the panel flashes them — but none between
    // one row and the next, since reading down a list is a single act of
    // comparison. The info icons opt out with delayDuration={0}: a small target
    // hovered on purpose has already asked the question.
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-4">
      {/* Period — the axis everything else is broken down along */}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Calendar size={14} className="text-muted-foreground" />
            <SectionLabel as="h3">{t('data_catalog.period_config_title')}</SectionLabel>
            <InfoHint text={t('data_catalog.period_config_hint')} />
          </div>
          <Switch checked={!!periodConfig} disabled={!canWrite || locked} onCheckedChange={togglePeriod} />
        </div>

        {periodConfig && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="catalog-granularity">{t('data_catalog.period_granularity')}</Label>
                <Select
                  value={periodConfig.granularity}
                  disabled={!canWrite || locked}
                  onValueChange={(v) => setGranularity(v as 'month' | 'quarter' | 'year')}
                >
                  <SelectTrigger id="catalog-granularity" className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month" className="text-xs">{t('data_catalog.period_granularity_month')}</SelectItem>
                    <SelectItem value="quarter" className="text-xs">{t('data_catalog.period_granularity_quarter')}</SelectItem>
                    <SelectItem value="year" className="text-xs">{t('data_catalog.period_granularity_year')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {careSiteDim?.enabled && availableServiceLabels.length > 0 && (
                <div className="grid gap-1.5">
                  <Label>{t('data_catalog.period_services_select')}</Label>
                  <MultiSelectFilter
                    value={periodConfig.serviceLabels ?? []}
                    options={availableServiceLabels}
                    placeholder={t('data_catalog.period_all_services')}
                    onChange={(vals) => setPeriod({ serviceLabels: vals.length > 0 ? vals : undefined })}
                    showChevron
                    popoverWidthClass="w-64"
                    triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, locked && 'pointer-events-none opacity-50')}
                  />
                </div>
              )}
            </div>

            {/* What each period row is widened by */}
            <div className="grid gap-2">
              <Label>{t('data_catalog.period_enrichments')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <ToggleRow
                  icon={Users}
                  label={t('data_catalog.dim_sex')}
                  checked={sexDim?.enabled ?? false}
                  disabled={!canWrite || locked}
                  onChange={(v) => sexDim && setDimension(sexDim.id, { enabled: v })}
                />
                <ToggleRow
                  icon={Users}
                  label={t('data_catalog.dim_age_group')}
                  checked={ageDim?.enabled ?? false}
                  disabled={!canWrite || locked}
                  onChange={(v) => ageDim && setDimension(ageDim.id, { enabled: v })}
                />
                <ToggleRow
                  label={t('data_catalog.period_services')}
                  checked={careSiteDim?.enabled ?? false}
                  disabled={!canWrite || locked}
                  onChange={(v) => careSiteDim && setDimension(careSiteDim.id, { enabled: v })}
                />
                {catalog.categoryColumn && (
                  <ToggleRow
                    icon={Tag}
                    label={t('data_catalog.period_concept_categories')}
                    checked={(periodConfig.conceptCategories?.length ?? 0) > 0}
                    disabled={!canWrite || locked || availableCategoryValues.length === 0}
                    onChange={(v) => setPeriod({ conceptCategories: v ? availableCategoryValues : [] })}
                  />
                )}
              </div>
            </div>

            {catalog.categoryColumn && (periodConfig.conceptCategories?.length ?? 0) > 0 && (
              <div className="grid gap-1.5">
                <Label>{t('data_catalog.period_concept_categories')}</Label>
                <MultiSelectFilter
                  value={periodConfig.conceptCategories ?? []}
                  options={availableCategoryValues}
                  placeholder={t('data_catalog.period_no_categories_selected')}
                  onChange={(vals) => setPeriod({ conceptCategories: vals })}
                  showChevron
                  popoverWidthClass="w-64"
                  triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, locked && 'pointer-events-none opacity-50')}
                />
              </div>
            )}

            {ageDim?.enabled && (
              <AgeBrackets
                brackets={currentBrackets}
                preset={activePreset}
                input={bracketInput}
                canEdit={canWrite && !locked}
                onInput={setBracketInput}
                onAdd={addBracket}
                onRemove={removeBracket}
                onPreset={(key) => {
                  const brackets = AGE_BRACKET_PRESETS[key]
                  if (brackets && ageDim) void setDimension(ageDim.id, { ageGroup: { brackets } })
                }}
              />
            )}
          </>
        )}
      </Card>

      {/* How the concepts are classified */}
      {availableExtraColumns.length > 0 && (
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-1.5">
            <Tag size={14} className="text-muted-foreground" />
            <SectionLabel as="h3">{t('data_catalog.classification_title')}</SectionLabel>
            <InfoHint text={t('data_catalog.classification_hint')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="catalog-category">{t('data_catalog.category_column')}</Label>
              <Select value={catalog.categoryColumn ?? '__none__'} disabled={!canWrite || locked} onValueChange={setCategoryColumn}>
                <SelectTrigger id="catalog-category" className="text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" className="text-xs text-muted-foreground">{t('data_catalog.none')}</SelectItem>
                  {availableExtraColumns.map((key) => (
                    <SelectItem key={key} value={key} className="text-xs">{key}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="catalog-subcategory">{t('data_catalog.subcategory_column')}</Label>
              <Select
                value={catalog.subcategoryColumn ?? '__none__'}
                disabled={!canWrite || locked}
                onValueChange={(v) => updateCatalog(catalog.id, { subcategoryColumn: v === '__none__' ? undefined : v })}
              >
                <SelectTrigger id="catalog-subcategory" className="text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" className="text-xs text-muted-foreground">{t('data_catalog.none')}</SelectItem>
                  {availableExtraColumns.filter((key) => key !== catalog.categoryColumn).map((key) => (
                    <SelectItem key={key} value={key} className="text-xs">{key}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>
      )}

      {/* Progress + controls */}
      <Card className="flex flex-col gap-2 p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {/* Each phase says what it is doing: silence here reads as a button
                that did nothing, and the concept pass alone can take minutes. */}
            {phase === 'mounting'
              ? t('data_catalog.step_mounting')
              : phase === 'concepts'
              ? t('data_catalog.compute_concepts')
              : phase === 'saving'
              ? t('data_catalog.step_saving')
              : catalog.lastComputedAt && !running
                ? (paused
                  ? t('data_catalog.compute_paused', { date: new Date(catalog.lastComputedAt).toLocaleString(i18n.language) })
                  : t('data_catalog.compute_complete', { date: new Date(catalog.lastComputedAt).toLocaleString(i18n.language) }))
                : t('data_catalog.compute_idle')}
          </span>
          {total > 0 && !preparing && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('data_catalog.compute_progress_count', {
                computed: computed.toLocaleString(i18n.language),
                total: total.toLocaleString(i18n.language),
              })}
              {snapshot.current && <span className="ml-1 text-muted-foreground/60">({snapshot.current})</span>}
            </span>
          )}
        </div>

        <Progress value={preparing ? 0 : percent} />

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => pauseCatalogRun(catalog.id)}>
              <Pause size={14} />
              {t('data_catalog.compute_pause')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => void run(false)}
              disabled={!mapping || !canWrite}
            >
              <Play size={14} />
              {paused ? t('data_catalog.compute_resume') : t('data_catalog.compute')}
            </Button>
          )}
          {(done || paused) && !running && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
              <RotateCcw size={14} />
              {t('data_catalog.compute_restart')}
            </Button>
          )}
          {(done || paused) && !running && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmDiscard(true)}
            >
              <Trash2 size={14} />
              {t('data_catalog.compute_discard')}
            </Button>
          )}
          {running && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
        </div>

        {!mapping && (
          <p className="text-[10px] text-muted-foreground">{t('data_catalog.compute_no_mapping')}</p>
        )}
        {done && catalog.lastComputeDurationMs != null && (
          <p className="text-[10px] text-muted-foreground">
            {t('data_catalog.compute_done_hint', { seconds: (catalog.lastComputeDurationMs / 1000).toFixed(1) })}
          </p>
        )}
      </Card>

      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_catalog.compute_restart_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('data_catalog.compute_restart_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmRestart(false); void run(true) }}>
              {t('data_catalog.compute_restart')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_catalog.compute_discard_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('data_catalog.compute_discard_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void discard()}
            >
              {t('data_catalog.compute_discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  )
}

/** One enrichment switch, sized to sit two-per-row beside its siblings. */
function ToggleRow({
  icon: Icon,
  label,
  checked,
  disabled,
  onChange,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon size={14} className="shrink-0 text-muted-foreground" />}
        <span className="truncate text-xs">{label}</span>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

/**
 * The age brackets, as one line of boundaries rather than a chain of intervals.
 *
 * The intervals used to be spelled out between the badges — `[0;10[ — 10 —
 * [10;20[ — 20 …` — which for the default nine boundaries ran to two full rows
 * of chrome for information the boundaries already carry: consecutive numbers
 * ARE the intervals. So the badges are just the boundaries now, with the open
 * ends named once at each end of the row, and the whole thing fits one line.
 */
function AgeBrackets({
  brackets,
  preset,
  input,
  canEdit,
  onInput,
  onAdd,
  onRemove,
  onPreset,
}: {
  brackets: number[]
  preset: string | null
  input: string
  canEdit: boolean
  onInput: (value: string) => void
  onAdd: () => void
  onRemove: (value: number) => void
  onPreset: (key: string) => void
}) {
  const { t } = useTranslation()
  const sorted = useMemo(() => [...brackets].sort((a, b) => a - b), [brackets])
  const addable = canEdit && !!input && !isNaN(parseInt(input)) && parseInt(input) > 0

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <Label>{t('data_catalog.age_brackets')}</Label>
        <InfoHint text={t('data_catalog.age_brackets_hint')} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Select value={preset ?? '__custom__'} disabled={!canEdit} onValueChange={onPreset}>
          <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.keys(AGE_BRACKET_PRESETS).map((key) => (
              <SelectItem key={key} value={key} className="text-xs">
                {t(`data_catalog.age_preset_${key}`)}
              </SelectItem>
            ))}
            {!preset && (
              <SelectItem value="__custom__" className="text-xs">{t('data_catalog.age_preset_custom')}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={input}
            disabled={!canEdit}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
            placeholder={t('data_catalog.age_add_bracket')}
            className="h-8 text-xs"
          />
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={onAdd} disabled={!addable}>
            {t('common.add')}
          </Button>
        </div>
      </div>
      {/* The boundaries themselves. `0` and `+∞` are the implicit ends, shown as
          plain text because they are not removable. */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-muted-foreground">0</span>
        {sorted.map((b) => (
          <Badge
            key={b}
            variant="secondary"
            className={cn('gap-1 pr-1 tabular-nums', canEdit && 'group cursor-pointer hover:bg-destructive/10 hover:text-destructive')}
            onClick={() => { if (canEdit) onRemove(b) }}
          >
            {b}
            {canEdit && <X size={10} className="text-muted-foreground/50 group-hover:text-destructive" />}
          </Badge>
        ))}
        <span className="text-[10px] text-muted-foreground">+∞</span>
      </div>
    </div>
  )
}

/**
 * An explanation behind an info icon.
 *
 * Worth reading once and never again, so it sits on hover rather than under the
 * field — a column of permanent hint text made the panel scroll for no lasting
 * benefit.
 */
function InfoHint({ text }: { text: string }): ReactNode {
  return (
    // No delay: an info icon is aimed at deliberately, unlike the option rows
    // whose tooltips need a beat so crossing the panel does not flash them.
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Info">
          <Info size={12} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs text-xs">{text}</TooltipContent>
    </Tooltip>
  )
}
