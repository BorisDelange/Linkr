import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, Calendar, Check, Gauge, Info, Layers, Loader2, Pause, Play, RotateCcw, Search, Stethoscope, Tag, Trash2, Users, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildServiceListQuery } from '@/lib/duckdb/catalog-queries'
import { estimateCrossings, estimateKey, getCachedEstimate, type CrossingEstimate } from '@/lib/duckdb/catalog-compute'
import { canonicalCrossing, crossingId, DEFAULT_AGE_BRACKETS, DEFAULT_CONCEPT_CONFIG, DEFAULT_SERVICE_CONFIG, enabledVariables } from '@/lib/data-catalog/config'
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
import type { CatalogResultCache, DataCatalog } from '@/types'
import {
  AGE_BRACKET_PRESETS,
  type CatalogVariableId,
  type CatalogVariables,
  type ConceptVariableConfig,
  type PeriodGranularity,
  type ServiceVariableConfig,
} from '@/types/catalog'
import { yieldClass } from './yield-class'

interface Props {
  catalog: DataCatalog
}

const VARIABLE_ICON: Record<CatalogVariableId, React.ComponentType<{ size?: number; className?: string }>> = {
  concept: Tag, period: Calendar, service: Stethoscope, age: Users, sex: Users,
}

/**
 * Configure what the catalog counts, then compute it — resumably.
 *
 * Three cards, in the order they are decided: the VARIABLES (each with its own
 * parameters), the CROSSINGS between them (with the share of cells a crossing
 * would publish, estimated on demand), then the run. The run itself lives in a
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
  const preparing = phase === 'mounting' || phase === 'concepts'

  const variables = catalog.variables
  const crossings = useMemo(() => catalog.crossings ?? [], [catalog.crossings])
  const enabled = useMemo(() => enabledVariables(variables), [variables])
  const query = useCallback(async (sql: string) => {
    await ensureMounted(catalog.dataSourceId)
    return queryDataSource(catalog.dataSourceId, sql)
  }, [catalog.dataSourceId, ensureMounted])

  // --- Config writers ---
  const setVariable = async <K extends CatalogVariableId>(id: K, patch: Partial<NonNullable<CatalogVariables[K]>>) => {
    const defaults: CatalogVariables = {
      concept: { ...DEFAULT_CONCEPT_CONFIG },
      period: { enabled: false, granularity: 'year' },
      service: { ...DEFAULT_SERVICE_CONFIG, groups: {} },
      age: { enabled: false, brackets: [...DEFAULT_AGE_BRACKETS] },
      sex: { enabled: false },
    }
    const current = variables[id] ?? defaults[id]
    await updateCatalog(catalog.id, { variables: { ...variables, [id]: { ...current, ...patch } } })
  }
  const toggleCrossing = async (vars: CatalogVariableId[]) => {
    const id = crossingId(vars)
    const has = crossings.some((c) => crossingId(c) === id)
    await updateCatalog(catalog.id, {
      crossings: has ? crossings.filter((c) => crossingId(c) !== id) : [...crossings, canonicalCrossing(vars)],
    })
  }
  const isCrossed = (vars: CatalogVariableId[]) => crossings.some((c) => crossingId(c) === crossingId(vars))

  // --- Yield estimates ---
  const [estimates, setEstimates] = useState<Record<string, CrossingEstimate>>({})
  const [estimating, setEstimating] = useState(false)
  const estimateOf = (vars: CatalogVariableId[]) => estimates[crossingId(vars)] ?? getCachedEstimate(estimateKey(catalog, vars))
  const estimate = async () => {
    if (!mapping) return
    setEstimating(true)
    try {
      // Every possible crossing of the enabled variables, not only the chosen
      // ones: the point is to choose.
      const all: CatalogVariableId[][] = []
      for (let i = 0; i < enabled.length; i++) {
        for (let j = i + 1; j < enabled.length; j++) {
          all.push([enabled[i], enabled[j]])
          for (let k = j + 1; k < enabled.length; k++) all.push([enabled[i], enabled[j], enabled[k]])
        }
      }
      await estimateCrossings({ ...catalog, crossings: all }, mapping, query, (id, e) => setEstimates((prev) => ({ ...prev, [id]: e })))
    } finally {
      setEstimating(false)
    }
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
      // The resume offset: null once the run is finished, so the panel stops
      // reading as paused.
      computedSteps: done ? null : cache.completedSteps ?? 0,
    }))
  }, [catalog.id, setResultCache, updateCatalog])

  const run = useCallback(async (restart: boolean) => {
    if (!mapping || !dataSource) return
    clearCatalogRunError(catalog.id)
    // A resume needs the cells already computed; only a fresh cache is discarded.
    const stored = restart ? null : await getStorage().catalogResults.get(catalog.id)
    const offset = catalog.computedSteps ?? null
    const resumeFrom = stored && offset != null ? { cache: stored, computed: offset } : null
    if (restart) await updateCatalog(catalog.id, clearedCatalogPatch({ computedSteps: null }))

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
      computedSteps: null,
    }))
    setSnapshot(getCatalogRunSnapshot(catalog.id))
  }, [catalog.id, setResultCache, updateCatalog])

  // `!= null` covers both: absent (never run) and an explicit null (finished).
  const savedOffset = catalog.computedSteps ?? null
  const computed = snapshot.computed ?? savedOffset ?? 0
  const total = snapshot.total ?? 0
  const paused = !running && savedOffset != null
  const done = !running && !paused && catalog.status === 'success'
  const percent = total > 0 ? Math.min(100, Math.round((computed / total) * 100)) : 0
  // The stored offset indexes the run's unit plan; changing a variable or a
  // crossing mid-run would make it point into a different plan.
  const locked = running || paused
  const editable = canWrite && !locked

  const pairs: CatalogVariableId[][] = []
  const triples: CatalogVariableId[][] = []
  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      pairs.push([enabled[i], enabled[j]])
      for (let k = j + 1; k < enabled.length; k++) triples.push([enabled[i], enabled[j], enabled[k]])
    }
  }
  const label = (v: CatalogVariableId) => t(`data_catalog.var_${v}`)

  return (
    // Option-row tooltips need a beat before the first one appears, none between
    // rows; the info icons opt out with delayDuration={0}.
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 py-4">
      {/* Variables */}
      <Card className="flex flex-col gap-0 p-0">
        <div className="flex items-center gap-1.5 px-5 pt-4 pb-3">
          <Layers size={14} className="text-muted-foreground" />
          <SectionLabel as="h3">{t('data_catalog.variables_title')}</SectionLabel>
          <InfoHint text={t('data_catalog.variables_hint')} />
        </div>

        <VariableRow id="period" enabled={!!variables.period?.enabled} disabled={!editable} onToggle={(v) => setVariable('period', { enabled: v })}
          summary={variables.period?.enabled ? t(`data_catalog.period_granularity_${variables.period.granularity}`) : undefined}>
          <div className="grid max-w-xs gap-1.5">
            <Label htmlFor="catalog-granularity">{t('data_catalog.period_granularity')}</Label>
            <Select value={variables.period?.granularity ?? 'year'} disabled={!editable} onValueChange={(v) => setVariable('period', { granularity: v as PeriodGranularity })}>
              <SelectTrigger id="catalog-granularity" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['month', 'quarter', 'year'] as const).map((g) => (
                  <SelectItem key={g} value={g} className="text-xs">{t(`data_catalog.period_granularity_${g}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </VariableRow>

        <VariableRow id="age" enabled={!!variables.age?.enabled} disabled={!editable} onToggle={(v) => setVariable('age', { enabled: v })}
          summary={variables.age?.enabled ? t('data_catalog.age_summary', { count: (variables.age.brackets?.length ?? 0) + 1 }) : undefined}>
          <AgeBracketsEditor brackets={variables.age?.brackets ?? DEFAULT_AGE_BRACKETS} canEdit={editable} onChange={(brackets) => setVariable('age', { brackets })} />
        </VariableRow>

        <VariableRow id="sex" enabled={!!variables.sex?.enabled} disabled={!editable || !mapping?.genderValues} onToggle={(v) => setVariable('sex', { enabled: v })}
          summary={!mapping?.genderValues ? t('data_catalog.sex_no_mapping') : undefined} />

        <VariableRow id="service" enabled={!!variables.service?.enabled} disabled={!editable} onToggle={(v) => setVariable('service', { enabled: v })}
          summary={variables.service?.enabled ? t(`data_catalog.service_grouping_${variables.service.grouping}_summary`, { n: variables.service.topN }) : undefined}>
          {variables.service && (
            <ServiceSettings config={variables.service} canEdit={editable} mapping={mapping} query={query} onChange={(patch) => setVariable('service', patch)} />
          )}
        </VariableRow>

        <VariableRow id="concept" enabled={!!variables.concept?.enabled} disabled={!editable} onToggle={(v) => setVariable('concept', { enabled: v })}
          summary={variables.concept?.enabled ? t(`data_catalog.concept_level_${variables.concept.level}`) : undefined} alwaysOpen last>
          <ConceptSettings config={variables.concept ?? DEFAULT_CONCEPT_CONFIG} canEdit={editable} mapping={mapping} onChange={(patch) => setVariable('concept', patch)} />
        </VariableRow>
      </Card>

      {/* Crossings */}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-1.5">
          <Gauge size={14} className="text-muted-foreground" />
          <SectionLabel as="h3">{t('data_catalog.crossings_title')}</SectionLabel>
          <InfoHint text={t('data_catalog.crossings_hint')} />
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!mapping || estimating || enabled.length < 2} onClick={() => void estimate()}>
            {estimating ? <Loader2 size={14} className="animate-spin" /> : <Gauge size={14} />}
            {t('data_catalog.estimate_yields')}
          </Button>
        </div>

        {enabled.length < 2 ? (
          <p className="text-xs text-muted-foreground">{t('data_catalog.crossings_need_two')}</p>
        ) : (
          <>
            <div className="grid gap-2">
              <Label>{t('data_catalog.crossings_pairs')}</Label>
              <div className="overflow-x-auto">
                <table className="border-separate border-spacing-1 text-xs">
                  <thead>
                    <tr>
                      <th />
                      {enabled.slice(1).map((v) => <th key={v} className="px-2 pb-1 text-left font-medium text-muted-foreground">{label(v)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {enabled.slice(0, -1).map((a, i) => (
                      <tr key={a}>
                        <th className="pr-3 text-right font-medium whitespace-nowrap text-muted-foreground">{label(a)}</th>
                        {enabled.slice(1).map((b, j) => (
                          <td key={b}>
                            {j >= i ? (
                              <CrossingToggle
                                checked={isCrossed([a, b])}
                                disabled={!editable}
                                estimate={estimateOf([a, b])}
                                onClick={() => void toggleCrossing([a, b])}
                                title={`${label(a)} × ${label(b)}`}
                              />
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {triples.length > 0 && (
              <div className="grid gap-2">
                <Label>{t('data_catalog.crossings_triples')}</Label>
                <div className="flex flex-wrap gap-2">
                  {triples.map((vars) => (
                    <CrossingToggle
                      key={crossingId(vars)}
                      wide
                      checked={isCrossed(vars)}
                      disabled={!editable}
                      estimate={estimateOf(vars)}
                      onClick={() => void toggleCrossing(vars)}
                      title={vars.map(label).join(' × ')}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
              <span>{t('data_catalog.crossings_marginals')}</span>
              <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-emerald-500" />{'≥ 90 %'}</span>
              <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-amber-500" />{'60–90 %'}</span>
              <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-red-500" />{'< 60 %'}</span>
              <span>{t('data_catalog.estimate_legend', { threshold: catalog.anonymization.threshold })}</span>
            </div>
          </>
        )}
      </Card>

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
            <Button size="sm" className="gap-1.5" onClick={() => void run(false)} disabled={!mapping || !canWrite}>
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

        {locked && <p className="text-[10px] text-muted-foreground">{t('data_catalog.config_locked')}</p>}
        {!mapping && <p className="text-[10px] text-muted-foreground">{t('data_catalog.compute_no_mapping')}</p>}
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
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void discard()}>
              {t('data_catalog.compute_discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  )
}

/** One variable: its switch, a one-line summary, and its parameters once enabled. */
function VariableRow({
  id, enabled, disabled, onToggle, summary, children, alwaysOpen, last,
}: {
  id: CatalogVariableId
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  summary?: string
  children?: ReactNode
  alwaysOpen?: boolean
  last?: boolean
}) {
  const { t } = useTranslation()
  const Icon = VARIABLE_ICON[id]
  const open = !!children && (enabled || alwaysOpen)
  return (
    <div className={cn('border-t px-5 py-3', last && 'rounded-b-xl')}>
      <div className="flex items-center gap-2.5">
        <Icon size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{t(`data_catalog.var_${id}`)}</span>
        <InfoHint text={t(`data_catalog.var_${id}_hint`)} />
        {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        <div className="flex-1" />
        <Switch checked={enabled} disabled={disabled} onCheckedChange={onToggle} aria-label={t(`data_catalog.var_${id}`)} />
      </div>
      {open && <div className="mt-3 pl-6">{children}</div>}
    </div>
  )
}

/** A crossing to pick, with the share of its cells the publication would keep. */
function CrossingToggle({
  checked, disabled, estimate, onClick, title, wide,
}: {
  checked: boolean
  disabled?: boolean
  estimate?: CrossingEstimate
  onClick: () => void
  title: string
  wide?: boolean
}) {
  const { t } = useTranslation()
  const pct = estimate && estimate.cells > 0 ? Math.round((estimate.published / estimate.cells) * 100) : null
  const button = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={checked}
      aria-label={title}
      className={cn(
        'flex h-9 items-center gap-2 rounded-md border px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        wide ? 'min-w-56' : 'w-28 justify-between',
        checked ? 'border-primary bg-primary/10 text-foreground' : 'border-dashed text-muted-foreground hover:border-primary/60 hover:text-foreground',
      )}
    >
      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-sm border', checked && 'border-primary bg-primary text-primary-foreground')}>
        {checked && <Check size={11} />}
      </span>
      {wide && <span className="truncate">{title}</span>}
      {wide && <span className="flex-1" />}
      {pct != null && <span className={cn('font-semibold tabular-nums', yieldClass(pct))}>{`${pct} %`}</span>}
    </button>
  )
  if (!estimate) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="font-medium">{title}</div>
        {t('data_catalog.estimate_tip', {
          published: estimate.published.toLocaleString(),
          cells: estimate.cells.toLocaleString(),
          patients: estimate.mass > 0 ? Math.round((estimate.publishedMass / estimate.mass) * 100) : 100,
        })}
      </TooltipContent>
    </Tooltip>
  )
}

/** Age brackets: a preset, or boundaries added and removed one by one. */
function AgeBracketsEditor({ brackets, canEdit, onChange }: { brackets: number[]; canEdit: boolean; onChange: (brackets: number[]) => void }) {
  const [input, setInput] = useState('')
  const preset = useMemo(() => {
    const json = JSON.stringify(brackets)
    return Object.entries(AGE_BRACKET_PRESETS).find(([, b]) => JSON.stringify(b) === json)?.[0] ?? null
  }, [brackets])
  const add = () => {
    const value = parseInt(input)
    setInput('')
    if (isNaN(value) || value <= 0 || brackets.includes(value)) return
    onChange([...brackets, value].sort((a, b) => a - b))
  }
  return (
    <AgeBrackets
      brackets={brackets}
      preset={preset}
      input={input}
      canEdit={canEdit}
      onInput={setInput}
      onAdd={add}
      onRemove={(v) => onChange(brackets.filter((b) => b !== v))}
      onPreset={(key) => { const b = AGE_BRACKET_PRESETS[key]; if (b) onChange(b) }}
    />
  )
}

/**
 * Where services come from and how they are grouped: every service as is, the
 * N largest and "Other", or named groups picked from the database's services.
 */
function ServiceSettings({
  config, canEdit, mapping, query, onChange,
}: {
  config: ServiceVariableConfig
  canEdit: boolean
  mapping: DataCatalogMapping
  query: (sql: string) => Promise<Record<string, unknown>[]>
  onChange: (patch: Partial<ServiceVariableConfig>) => void
}) {
  const { t } = useTranslation()
  const [services, setServices] = useState<{ name: string; patients: number }[] | null>(null)
  const [search, setSearch] = useState('')
  const canVisit = !!mapping?.visitTable?.typeColumn
  const canDetail = !!mapping?.visitDetailTable

  useEffect(() => {
    if (config.grouping !== 'manual' || !mapping) return
    const sql = buildServiceListQuery(mapping, config.level)
    if (!sql) { setServices([]); return }
    let cancelled = false
    setServices(null)
    query(sql)
      .then((rows) => { if (!cancelled) setServices(rows.map((r) => ({ name: String(r.svc), patients: Number(r.patients ?? 0) }))) })
      .catch(() => { if (!cancelled) setServices([]) })
    return () => { cancelled = true }
  }, [config.grouping, config.level, mapping, query])

  const groups = useMemo(() => [...new Set(Object.values(config.groups ?? {}).map((g) => g.trim()).filter(Boolean))].sort(), [config.groups])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (services ?? []).filter((s) => !q || s.name.toLowerCase().includes(q) || (config.groups?.[s.name] ?? '').toLowerCase().includes(q))
  }, [services, search, config.groups])
  const setGroup = (service: string, group: string) => {
    const next = { ...(config.groups ?? {}) }
    if (group.trim()) next[service] = group
    else delete next[service]
    onChange({ groups: next })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label>{t('data_catalog.service_level')}</Label>
          <Select value={config.level} disabled={!canEdit} onValueChange={(v) => onChange({ level: v as ServiceVariableConfig['level'], groups: {} })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="visit_detail" className="text-xs" disabled={!canDetail}>{t('data_catalog.service_level_visit_detail')}</SelectItem>
              <SelectItem value="visit" className="text-xs" disabled={!canVisit}>{t('data_catalog.service_level_visit')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t('data_catalog.service_grouping')}</Label>
          <Tabs value={config.grouping} onValueChange={(v) => canEdit && onChange({ grouping: v as ServiceVariableConfig['grouping'] })}>
            <TabsList className="h-8 w-full">
              {(['all', 'top', 'manual'] as const).map((g) => (
                <TabsTrigger key={g} value={g} disabled={!canEdit} className="flex-1 text-xs">{t(`data_catalog.service_grouping_${g}`)}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {config.grouping === 'top' && (
        <div className="flex items-center gap-2 text-xs">
          <span>{t('data_catalog.service_top_keep')}</span>
          <Input type="number" min={1} value={config.topN} disabled={!canEdit} className="h-8 w-20 text-xs"
            onChange={(e) => onChange({ topN: Math.max(1, parseInt(e.target.value) || 1) })} />
          <span className="text-muted-foreground">{t('data_catalog.service_top_rest')}</span>
        </div>
      )}

      {config.grouping === 'manual' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative max-w-xs flex-1">
              <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-8 pl-8 text-xs" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('data_catalog.service_search')} />
            </div>
            <div className="flex-1" />
            <Label className="text-muted-foreground">{t('data_catalog.service_unassigned')}</Label>
            <Select value={config.unassigned} disabled={!canEdit} onValueChange={(v) => onChange({ unassigned: v as ServiceVariableConfig['unassigned'] })}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="other" className="text-xs">{t('data_catalog.service_unassigned_other')}</SelectItem>
                <SelectItem value="keep" className="text-xs">{t('data_catalog.service_unassigned_keep')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {services == null ? (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />{t('common.loading')}</div>
            ) : shown.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">{t('data_catalog.no_results')}</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">{t('data_catalog.var_service')}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t('data_catalog.col_patients')}</th>
                    <th className="w-56 px-3 py-1.5 text-left font-medium">{t('data_catalog.service_group')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => (
                    <tr key={s.name} className="border-t">
                      <td className="px-3 py-1">{s.name}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{s.patients.toLocaleString()}</td>
                      <td className="px-3 py-1">
                        <Input
                          list="catalog-service-groups"
                          defaultValue={config.groups?.[s.name] ?? ''}
                          disabled={!canEdit}
                          placeholder={config.unassigned === 'other' ? t('data_catalog.other_services') : s.name}
                          onBlur={(e) => { if (e.target.value !== (config.groups?.[s.name] ?? '')) setGroup(s.name, e.target.value) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                          className="h-7 text-xs"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <datalist id="catalog-service-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          {groups.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">{t('data_catalog.service_groups_list')}</span>
              {groups.map((g) => (
                <Badge key={g} variant="secondary">{`${g} · ${Object.values(config.groups).filter((x) => x.trim() === g).length}`}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type DataCatalogMapping = ReturnType<typeof useDataSourceStore.getState>['dataSources'][number]['schemaMapping']

/**
 * What a concept modality is: the concept itself, or its category or
 * subcategory from the dictionary. The category columns also classify the
 * concept list, whether or not concepts are crossed.
 */
function ConceptSettings({
  config, canEdit, mapping, onChange,
}: {
  config: ConceptVariableConfig
  canEdit: boolean
  mapping: DataCatalogMapping
  onChange: (patch: Partial<ConceptVariableConfig>) => void
}) {
  const { t } = useTranslation()
  const columns = useMemo(() => {
    const keys = new Set<string>()
    for (const d of mapping?.conceptTables ?? []) {
      if (d.categoryColumn) keys.add(d.categoryColumn)
      if (d.subcategoryColumn) keys.add(d.subcategoryColumn)
      for (const key of Object.keys(d.extraColumns ?? {})) keys.add(key)
    }
    return [...keys].sort()
  }, [mapping])
  const none = '__none__'

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label>{t('data_catalog.category_column')}</Label>
          <Select value={config.categoryColumn ?? none} disabled={!canEdit}
            onValueChange={(v) => {
              const col = v === none ? undefined : v
              onChange({
                categoryColumn: col,
                // A column cannot be both; picking it as the category frees the other slot.
                ...(config.subcategoryColumn === col ? { subcategoryColumn: undefined } : {}),
                ...(!col && config.level !== 'concept' ? { level: 'concept' as const } : {}),
              })
            }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={none} className="text-xs text-muted-foreground">{t('data_catalog.none')}</SelectItem>
              {columns.map((key) => <SelectItem key={key} value={key} className="text-xs">{key}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t('data_catalog.subcategory_column')}</Label>
          <Select value={config.subcategoryColumn ?? none} disabled={!canEdit}
            onValueChange={(v) => onChange({
              subcategoryColumn: v === none ? undefined : v,
              ...(v === none && config.level === 'subcategory' ? { level: 'concept' as const } : {}),
            })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={none} className="text-xs text-muted-foreground">{t('data_catalog.none')}</SelectItem>
              {columns.filter((key) => key !== config.categoryColumn).map((key) => <SelectItem key={key} value={key} className="text-xs">{key}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {config.enabled && (
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <Label>{t('data_catalog.concept_level')}</Label>
            <Select value={config.level} disabled={!canEdit} onValueChange={(v) => onChange({ level: v as ConceptVariableConfig['level'] })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="concept" className="text-xs">{t('data_catalog.concept_level_concept')}</SelectItem>
                <SelectItem value="category" className="text-xs" disabled={!config.categoryColumn}>{t('data_catalog.concept_level_category')}</SelectItem>
                <SelectItem value="subcategory" className="text-xs" disabled={!config.subcategoryColumn}>{t('data_catalog.concept_level_subcategory')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.level === 'concept' && (
            <div className="grid gap-1.5">
              <Label>{t('data_catalog.concept_scope')}</Label>
              <div className="flex items-center gap-2">
                <Select value={config.scope} disabled={!canEdit} onValueChange={(v) => onChange({ scope: v as ConceptVariableConfig['scope'] })}>
                  <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">{t('data_catalog.concept_scope_all')}</SelectItem>
                    <SelectItem value="top" className="text-xs">{t('data_catalog.concept_scope_top')}</SelectItem>
                  </SelectContent>
                </Select>
                {config.scope === 'top' && (
                  <Input type="number" min={1} value={config.topN} disabled={!canEdit} className="h-8 w-24 text-xs"
                    onChange={(e) => onChange({ topN: Math.max(1, parseInt(e.target.value) || 1) })} />
                )}
              </div>
            </div>
          )}
        </div>
      )}
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
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-muted-foreground">0</span>
        {sorted.map((b) => (
          <Badge key={b} variant="secondary" className={cn('gap-0.5 tabular-nums', canEdit && 'pr-0.5')}>
            {b}
            {canEdit && (
              <button
                type="button"
                onClick={() => onRemove(b)}
                className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-destructive/15 hover:text-destructive"
                aria-label={t('common.remove')}
              >
                <X size={10} />
              </button>
            )}
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
