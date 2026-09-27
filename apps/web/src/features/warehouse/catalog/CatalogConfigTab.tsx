import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { classRelation, conceptRelations, has } from '@/lib/schema-classes/relations'
import { fieldColumn } from '@/lib/schema-classes/spec'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, Check, Gauge, Info, Layers, Loader2, Pause, Play, RotateCcw, Search, Sigma, Square, Trash2, X,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/ui/number-input'
import { Progress } from '@/components/ui/progress'
import { RunSteps, type RunStepItem } from '@/components/ui/run-steps'
import { SectionLabel } from '@/components/ui/section-label'
import { Switch } from '@/components/ui/switch'
import { SuggestInput } from '@/components/ui/suggest-input'
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
import { estimateCrossings, estimateKey, getCachedEstimate, type CatalogUnitInfo, type CrossingEstimate, type EstimateProgress } from '@/lib/duckdb/catalog-compute'
import { canonicalCrossing, catalogCounts, crossingId, DEFAULT_AGE_BRACKETS, DEFAULT_CONCEPT_CONFIG, DEFAULT_SERVICE_CONFIG, enabledVariables } from '@/lib/data-catalog/config'
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
import type { CatalogCounts, CatalogResultCache, DataCatalog } from '@/types'
import {
  AGE_BRACKET_PRESETS,
  type CatalogVariableId,
  type CatalogVariables,
  type ConceptVariableConfig,
  type PeriodGranularity,
  type ServiceVariableConfig,
} from '@/types/catalog'
import { yieldClass } from './yield-class'
import { CrossingBadges, VariableBadge } from './variable-badge'
import { VARIABLE_ICON } from './variable-icons'
import { VARIABLE_COLORS } from '@/lib/data-catalog/variable-colors'
import { withAnonymizationImpact } from '@/lib/data-catalog/publish'

interface Props {
  catalog: DataCatalog
}

const CARD_ORDER: CatalogVariableId[] = ['period', 'age', 'sex', 'service', 'concept']

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

  const { running, error } = snapshot
  // The crossing units are planned only once the rankings are in: until then the bar has no total.
  const preparing = running && snapshot.total == null

  const variables = catalog.variables
  const crossings = useMemo(() => catalog.crossings ?? [], [catalog.crossings])
  // In the order of the Variables card, so the crossings read the same way.
  const enabled = useMemo(() => enabledVariables(variables).sort((a, b) => CARD_ORDER.indexOf(a) - CARD_ORDER.indexOf(b)), [variables])
  const query = useCallback(async (sql: string, signal?: AbortSignal) => {
    await ensureMounted(catalog.dataSourceId)
    return queryDataSource(catalog.dataSourceId, sql, { signal, allRows: true })
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
  /** Pick or drop every crossing of a group (the pairs, or the triples), leaving the others as they are. */
  const setCrossings = async (group: CatalogVariableId[][], on: boolean) => {
    const ids = new Set(group.map(crossingId))
    const kept = crossings.filter((c) => !ids.has(crossingId(c)))
    await updateCatalog(catalog.id, { crossings: on ? [...kept, ...group.map(canonicalCrossing)] : kept })
  }

  // --- Yield estimates ---
  const [estimates, setEstimates] = useState<Record<string, CrossingEstimate>>({})
  // Null when idle. Each estimate is a whole aggregate over the warehouse, so
  // the run can be stopped: the query in flight is interrupted.
  const [estimating, setEstimating] = useState<EstimateProgress | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const estimateAbort = useRef<AbortController | null>(null)
  useEffect(() => () => estimateAbort.current?.abort(), [])
  const estimateOf = (vars: CatalogVariableId[]) => estimates[crossingId(vars)] ?? getCachedEstimate(estimateKey(catalog, vars))
  const estimate = async () => {
    if (!mapping) return
    const controller = new AbortController()
    estimateAbort.current = controller
    setEstimateError(null)
    setEstimating({ done: 0, total: 0, current: null })
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
      await estimateCrossings({ ...catalog, crossings: all }, mapping, query, {
        signal: controller.signal,
        onEstimate: (id, e) => setEstimates((prev) => ({ ...prev, [id]: e })),
        onProgress: setEstimating,
      })
    } catch (err) {
      if (!controller.signal.aborted) setEstimateError(err instanceof Error ? err.message : String(err))
    } finally {
      if (estimateAbort.current === controller) estimateAbort.current = null
      setEstimating(null)
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

  const persist = useCallback(async (computed: CatalogResultCache, done: boolean) => {
    // A finished run starts with the masks of the current settings worked out,
    // so the Anonymization tab has them without a Run of its own.
    const cache = done ? withAnonymizationImpact(catalog, computed) : computed
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
  }, [catalog, setResultCache, updateCatalog])

  const run = useCallback(async (restart: boolean) => {
    if (!mapping || !dataSource) return
    clearCatalogRunError(catalog.id)
    // A resume needs the counts already made; only a fresh cache is discarded.
    const stored = restart ? null : await getStorage().catalogResults.get(catalog.id)
    const resumeFrom = stored && catalog.computedSteps != null ? { cache: stored } : null
    if (restart) await updateCatalog(catalog.id, clearedCatalogPatch({ computedSteps: null }))

    startCatalogRun({
      catalog,
      mapping,
      ensureMounted: () => ensureMounted(catalog.dataSourceId).then(() => {}),
      query: (sql, signal) => queryDataSource(catalog.dataSourceId, sql, { signal, allRows: true }),
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

  const singles: CatalogVariableId[][] = enabled.map((v) => [v])
  const pairs: CatalogVariableId[][] = []
  const triples: CatalogVariableId[][] = []
  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      pairs.push([enabled[i], enabled[j]])
      for (let k = j + 1; k < enabled.length; k++) triples.push([enabled[i], enabled[j], enabled[k]])
    }
  }
  const label = (v: CatalogVariableId) => t(`data_catalog.var_${v}`)
  const unitDetail = (u: CatalogUnitInfo | null): string | null => {
    if (!u) return null
    const parts: string[] = []
    if (u.crossing) parts.push(u.crossing.map(label).join(' × '))
    if (u.dictionary) parts.push(u.dictionary)
    if (u.ranked) parts.push(t(`data_catalog.var_${u.ranked}`))
    if (u.chunk) parts.push(t('data_catalog.run_chunk', { i: u.chunk[0], n: u.chunk[1] }))
    if (u.slice) parts.push(t('data_catalog.run_slice', { i: u.slice[0], n: u.slice[1] }))
    return parts.join(' · ') || null
  }
  const runSteps: RunStepItem[] = (['mounting', 'sizing', 'concepts', 'totals', 'ranking', 'crossings', 'saving'] as const)
    .filter((id) => id === 'mounting' || id === 'saving' || id === 'sizing' || snapshot.steps[id] != null || !running)
    .filter((id) => id !== 'ranking' || (snapshot.steps.ranking?.total ?? 0) > 0)
    .map((id, _, list) => {
      const order = list.indexOf(id)
      const current = snapshot.phase ? list.indexOf(snapshot.phase) : -1
      const progress = id !== 'mounting' && id !== 'saving' ? snapshot.steps[id] : undefined
      const status = snapshot.phase === id ? 'active' as const
        : (progress && progress.total != null && progress.done >= progress.total) || (current > order) ? 'done' as const
        : 'pending' as const
      return {
        id,
        label: t(`data_catalog.run_step_${id}`),
        status,
        progress,
        detail: snapshot.phase === id ? unitDetail(snapshot.current) : undefined,
      }
    })
  const hasGender = !!mapping && has(classRelation(mapping, 'patient'), 'gender')

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

        <CountsRow
          counts={catalogCounts(catalog)}
          disabled={!editable}
          hasUnitStays={!!mapping && !!classRelation(mapping, 'visit_detail')}
          onChange={(patch) => updateCatalog(catalog.id, { counts: { ...catalogCounts(catalog), ...patch } })}
        />

        <VariableRow id="period" enabled={!!variables.period?.enabled} disabled={!editable} onToggle={(v) => setVariable('period', { enabled: v })}
          summary={variables.period?.enabled
            ? ((variables.period.step ?? 1) > 1
              ? t('data_catalog.period_step_summary', { n: variables.period.step, unit: t(`data_catalog.period_units_${variables.period.granularity}`) })
              : t(`data_catalog.period_granularity_${variables.period.granularity}`))
            : undefined}>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="catalog-granularity">{t('data_catalog.period_granularity')}</Label>
              <Select value={variables.period?.granularity ?? 'year'} disabled={!editable} onValueChange={(v) => setVariable('period', { granularity: v as PeriodGranularity })}>
                <SelectTrigger id="catalog-granularity" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['month', 'quarter', 'year'] as const).map((g) => (
                    <SelectItem key={g} value={g} className="text-xs">{t(`data_catalog.period_granularity_${g}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="catalog-period-step">{t('data_catalog.period_step')}</Label>
              <div className="flex items-center gap-2">
                <NumberInput
                  id="catalog-period-step"
                  min={1}
                  value={variables.period?.step ?? 1}
                  disabled={!editable}
                  className="h-8 w-20 text-xs"
                  onValueChange={(step) => setVariable('period', { step })}
                />
                <span className="text-xs text-muted-foreground">{t(`data_catalog.period_unit_${variables.period?.granularity ?? 'year'}`)}</span>
              </div>
            </div>
          </div>
        </VariableRow>

        <VariableRow id="age" enabled={!!variables.age?.enabled} disabled={!editable} onToggle={(v) => setVariable('age', { enabled: v })}
          summary={variables.age?.enabled ? t('data_catalog.age_summary', { count: (variables.age.brackets?.length ?? 0) + 1 }) : undefined}>
          <AgeBracketsEditor brackets={variables.age?.brackets ?? DEFAULT_AGE_BRACKETS} canEdit={editable} onChange={(brackets) => setVariable('age', { brackets })} />
        </VariableRow>

        <VariableRow id="sex" enabled={!!variables.sex?.enabled} disabled={!editable || !hasGender} onToggle={(v) => setVariable('sex', { enabled: v })}
          summary={!hasGender ? t('data_catalog.sex_no_mapping') : undefined} />

        <VariableRow id="service" enabled={!!variables.service?.enabled} disabled={!editable} onToggle={(v) => setVariable('service', { enabled: v })}
          summary={variables.service?.enabled ? t(`data_catalog.service_grouping_${variables.service.grouping}_summary`, { n: variables.service.topN }) : undefined}>
          {variables.service && (
            <ServiceSettings config={variables.service} canEdit={editable} mapping={mapping} query={query} onChange={(patch) => setVariable('service', patch)} />
          )}
        </VariableRow>

        <VariableRow id="concept" enabled={!!variables.concept?.enabled} disabled={!editable} onToggle={(v) => setVariable('concept', { enabled: v })}
          summary={variables.concept?.enabled ? t('data_catalog.concept_level_summary', { level: t(`data_catalog.concept_level_${variables.concept.level}`).toLowerCase() }) : undefined} alwaysOpen last>
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
          {estimating && (
            <span className="max-w-64 truncate text-[10px] tabular-nums text-muted-foreground">
              {estimating.total > 0 && `${estimating.done} / ${estimating.total}`}
              {estimating.current && ` · ${estimating.current === 'ranking' ? t('data_catalog.estimate_ranking') : estimating.current.map(label).join(' × ')}`}
            </span>
          )}
          {estimating ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => estimateAbort.current?.abort()}>
              <Square size={12} />
              {t('data_catalog.estimate_stop')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="gap-1.5" disabled={!mapping || enabled.length < 1} onClick={() => void estimate()}>
              <Gauge size={14} />
              {t('data_catalog.estimate_yields')}
            </Button>
          )}
        </div>
        {estimateError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{estimateError}</span>
          </div>
        )}

        {enabled.length > 0 && (
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Label>{t('data_catalog.crossings_singles')}</Label>
              <InfoHint text={t('data_catalog.crossings_singles_hint')} />
              <SelectAllNone disabled={!editable} onAll={() => void setCrossings(singles, true)} onNone={() => void setCrossings(singles, false)} />
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {singles.map((vars) => (
                <CrossingToggle
                  key={crossingId(vars)}
                  wide
                  vars={vars}
                  checked={isCrossed(vars)}
                  disabled={!editable}
                  estimate={estimateOf(vars)}
                  onClick={() => void toggleCrossing(vars)}
                  title={label(vars[0])}
                />
              ))}
            </div>
          </div>
        )}

        {enabled.length < 2 ? (
          <p className="text-xs text-muted-foreground">{t('data_catalog.crossings_need_two')}</p>
        ) : (
          <>
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Label>{t('data_catalog.crossings_pairs')}</Label>
                <SelectAllNone disabled={!editable} onAll={() => void setCrossings(pairs, true)} onNone={() => void setCrossings(pairs, false)} />
              </div>
              <div className="overflow-x-auto">
                <table className="border-separate border-spacing-1 text-xs">
                  <thead>
                    <tr>
                      <th />
                      {enabled.slice(1).map((v) => <th key={v} className="px-1 pb-1 text-left font-normal"><VariableBadge id={v} /></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {enabled.slice(0, -1).map((a, i) => (
                      <tr key={a}>
                        <th className="pr-2 text-right font-normal whitespace-nowrap"><VariableBadge id={a} /></th>
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
                <div className="flex items-center gap-2">
                  <Label>{t('data_catalog.crossings_triples')}</Label>
                  <SelectAllNone disabled={!editable} onAll={() => void setCrossings(triples, true)} onNone={() => void setCrossings(triples, false)} />
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {triples.map((vars) => (
                    <CrossingToggle
                      key={crossingId(vars)}
                      wide
                      vars={vars}
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
            {running
              ? t('data_catalog.compute_running')
              : catalog.lastComputedAt
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
            </span>
          )}
        </div>

        {/* A finished computation reads as a full bar, whenever it ran. */}
        <Progress value={done ? 100 : preparing ? 0 : percent} indicatorClassName={done ? 'bg-foreground' : undefined} />
        {running && <RunSteps steps={runSteps} className="mt-2" />}

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

/** "Select all / None", as the app's other multi-pick lists write it. */
function SelectAllNone({ onAll, onNone, disabled }: { onAll: () => void; onNone: () => void; disabled?: boolean }) {
  const { t } = useTranslation()
  if (disabled) return null
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <button type="button" onClick={onAll} className="hover:text-foreground">{t('common.select_all')}</button>
      <span className="text-muted-foreground/40">/</span>
      <button type="button" onClick={onNone} className="hover:text-foreground">{t('common.select_none')}</button>
    </div>
  )
}

/**
 * What every cell counts: patients always, hospital stays and unit stays on
 * demand — each is one more distinct count per cell, which a large warehouse
 * pays for in time and memory.
 */
function CountsRow({ counts, disabled, hasUnitStays, onChange }: {
  counts: CatalogCounts
  disabled?: boolean
  hasUnitStays: boolean
  onChange: (patch: Partial<CatalogCounts>) => void
}) {
  const { t } = useTranslation()
  const option = (id: string, label: string, checked: boolean, onToggle?: (on: boolean) => void, hint?: string) => (
    <label htmlFor={id} className={cn('flex items-center gap-1.5 text-xs', !onToggle || disabled ? 'cursor-default' : 'cursor-pointer')} title={hint}>
      <Checkbox id={id} checked={checked} disabled={!onToggle || disabled} onCheckedChange={(v) => onToggle?.(v === true)} />
      <span className={cn(!onToggle && 'text-muted-foreground')}>{label}</span>
    </label>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t px-5 py-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Sigma size={13} />
      </span>
      <span className="text-sm font-medium">{t('data_catalog.counts_title')}</span>
      <InfoHint text={t('data_catalog.counts_hint')} />
      <div className="flex-1" />
      <div className="flex flex-wrap items-center gap-4">
        {option('catalog-count-patients', t('data_catalog.count_patients'), true)}
        {option('catalog-count-visits', t('data_catalog.count_visits'), counts.visits, (on) => onChange({ visits: on }))}
        {option(
          'catalog-count-unit-stays',
          t('data_catalog.count_unit_stays'),
          counts.unitStays && hasUnitStays,
          hasUnitStays ? (on) => onChange({ unitStays: on }) : undefined,
          hasUnitStays ? undefined : t('data_catalog.count_unit_stays_no_mapping'),
        )}
      </div>
    </div>
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
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', VARIABLE_COLORS[id].bg, VARIABLE_COLORS[id].icon)}>
          <Icon size={13} />
        </span>
        <span className="text-sm font-medium">{t(`data_catalog.var_${id}`)}</span>
        <InfoHint text={t(`data_catalog.var_${id}_hint`)} />
        {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        <div className="flex-1" />
        <Switch checked={enabled} disabled={disabled} onCheckedChange={onToggle} aria-label={t(`data_catalog.var_${id}`)} />
      </div>
      {open && <div className="mt-3 pl-8.5">{children}</div>}
    </div>
  )
}

/** A crossing to pick, with the share of its cells the publication would keep. */
function CrossingToggle({
  checked, disabled, estimate, onClick, title, wide, vars,
}: {
  checked: boolean
  disabled?: boolean
  estimate?: CrossingEstimate
  onClick: () => void
  title: string
  wide?: boolean
  /** Shown as badges on a wide toggle. */
  vars?: CatalogVariableId[]
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
        'flex items-center gap-2 rounded-md border text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        wide ? 'min-h-9 w-full px-2.5 py-1.5' : 'h-7 w-20 justify-between px-2',
        checked ? 'border-primary/50 text-foreground' : 'border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
      )}
    >
      <span className={cn('flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
        {checked && <Check size={10} />}
      </span>
      {wide && (vars ? <CrossingBadges vars={vars} /> : <span className="truncate">{title}</span>)}
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
  const canVisit = !!mapping && has(classRelation(mapping, 'visit'), 'visit_type')
  const canDetail = !!mapping && !!classRelation(mapping, 'visit_detail')

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
            <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="visit_detail" className="text-xs" disabled={!canDetail}>{t('data_catalog.service_level_visit_detail')}</SelectItem>
              <SelectItem value="visit" className="text-xs" disabled={!canVisit}>{t('data_catalog.service_level_visit')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t('data_catalog.service_grouping')}</Label>
          <Select value={config.grouping} disabled={!canEdit} onValueChange={(v) => onChange({ grouping: v as ServiceVariableConfig['grouping'] })}>
            <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(['all', 'top', 'manual'] as const).map((g) => (
                <SelectItem key={g} value={g} className="text-xs">{t(`data_catalog.service_grouping_${g}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {config.grouping === 'top' && (
        <div className="flex items-center gap-2 text-xs">
          <span>{t('data_catalog.service_top_keep')}</span>
          <NumberInput min={1} value={config.topN} disabled={!canEdit} className="h-8 w-20 text-xs"
            onValueChange={(topN) => onChange({ topN })} />
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
                <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
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
                        {canEdit ? (
                          <SuggestInput
                            value={config.groups?.[s.name] ?? ''}
                            suggestions={groups}
                            placeholder={config.unassigned === 'other' ? t('data_catalog.other_services') : s.name}
                            onCommit={(v) => setGroup(s.name, v)}
                            className="font-sans"
                          />
                        ) : (
                          <span className="text-muted-foreground">{config.groups?.[s.name] ?? ''}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {(groups.length > 0 || (services?.length ?? 0) > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">{t('data_catalog.service_groups_list')}</span>
              {groups.map((g) => (
                <Badge key={g} variant="secondary">{`${g} · ${Object.values(config.groups).filter((x) => x.trim() === g).length}`}</Badge>
              ))}
              {services && (
                // Services the list shows with no group yet: how much is left to sort.
                <Badge variant="outline" className="text-muted-foreground">
                  {`${t('data_catalog.service_groups_none')} · ${services.filter((sv) => !(config.groups?.[sv.name] ?? '').trim()).length}`}
                </Badge>
              )}
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
    // The dictionaries' category and subcategory, by the source column they read
    // (what a saved catalog config names), and their extra columns.
    for (const d of mapping ? conceptRelations(mapping) : []) {
      const spec = mapping?.concepts?.find((c) => c.key === d.key)
      for (const column of ['category', 'subcategory'] as const) {
        if (has(d, column)) keys.add(fieldColumn(spec, column)?.column ?? column)
      }
      for (const key of Object.keys(d.extras ?? {})) keys.add(key)
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
                  <NumberInput min={1} value={config.topN} disabled={!canEdit} className="h-8 w-24 text-xs"
                    onValueChange={(topN) => onChange({ topN })} />
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
