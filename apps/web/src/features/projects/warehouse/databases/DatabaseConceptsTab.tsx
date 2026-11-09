import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { AlertCircle, AlertTriangle, BarChart3, ChevronDown, ChevronUp, Loader2, Pause, Play, RefreshCw, RotateCcw, Rows3, Users, X } from 'lucide-react'
import { useSessionDismissal } from '@/hooks/use-session-dismissal'
import type { VisibilityState } from '@tanstack/react-table'
import type { SchemaMapping } from '@/types/schema-mapping'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { FieldInfo } from '@/components/ui/field-info'
import { Label } from '@/components/ui/label'
import { MULTI_SELECT_FORM_TRIGGER, MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RunSteps, type RunStepItem, type RunStepStatus } from '@/components/ui/run-steps'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConcepts } from '../concepts/use-concepts'
import { ConceptTable } from '../concepts/ConceptTable'
import { ConceptDetail } from '../concepts/ConceptDetail'
import { useConceptStatsSql } from '../concepts/use-concept-stats-sql'
import { useStoredProfile } from '../concepts/use-stored-profile'
import { useConceptProfiles } from './use-concept-profiles'
import { SECTION_GROUPS, type SectionKey } from '@/lib/concept-profiles/profile-store'
import { DEFAULT_HIDDEN_COLUMNS } from '../concepts/concept-queries'
import { prepareCountSpec } from '../concepts/concept-count-runner'
import type { ConceptCountStep, ConceptCountStepProgress } from '../concepts/concept-count-plan'

/** The count's steps, and the statistics: the concept profiles (useConceptProfiles). */
type Step = ConceptCountStep | 'stats'
const STEPS: readonly Step[] = ['records', 'patients', 'stats']
const STEP_ICONS = { records: Rows3, patients: Users, stats: BarChart3 }

interface DatabaseConceptsTabProps {
  dataSourceId: string
  schemaMapping: SchemaMapping
  readOnly?: boolean
}

/**
 * A database's concepts: where they are loaded into Linkr with the counts and
 * statistics asked for — run, paused, resumed — for every project and picker
 * that lists them, and the list itself.
 */
export function DatabaseConceptsTab({ dataSourceId, schemaMapping, readOnly = false }: DatabaseConceptsTabProps) {
  const { t, i18n } = useTranslation()
  const concepts = useConcepts(dataSourceId, schemaMapping, 'database')
  const profiles = useConceptProfiles(dataSourceId, schemaMapping)
  const { count } = concepts
  const [confirmRestart, setConfirmRestart] = useState(false)
  // Started over with the statistics: those stored are dropped once the counts
  // are done, so meanwhile their step reads as not started.
  const [statsReset, setStatsReset] = useState(false)
  // What the user ticked, for this database; untouched, every step. None loads
  // the concepts alone — searchable, not sortable by use.
  const [ticked, setTicked] = useState<{ dataSourceId: string; steps: ReadonlySet<Step> } | null>(null)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(DEFAULT_HIDDEN_COLUMNS.map((id) => [id, false])),
  )
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const { selectedConceptId, setSelectedConceptId } = concepts
  const profile = useStoredProfile(
    dataSourceId,
    (concepts.selectedConcept?._dict_key as string | undefined) ?? schemaMapping.concepts?.[0]?.key,
    selectedConceptId,
    profiles.version,
  )
  const { hasValueColumn, statsSql } = useConceptStatsSql(
    dataSourceId, schemaMapping, concepts.concepts, selectedConceptId, concepts.excludeOutliers,
  )

  const { live, progress } = count
  // Client-only mode reads the dictionaries live: no count to run, only the statistics.
  const countable = {
    records: count.enabled && count.countable.records,
    patients: count.enabled && count.countable.patients,
    stats: profiles.offered.length > 0,
  }
  const listed = !count.enabled || count.exists
  const picked: ReadonlySet<Step> = ticked?.dataSourceId === dataSourceId ? ticked.steps : new Set(STEPS)
  const counting = live.running
  const running = counting || profiles.running || profiles.starting
  // Shown from the click on: the run stops only once its query in flight does.
  const [pauseAsked, setPauseAsked] = useState(false)
  if (pauseAsked && !running) setPauseAsked(false)
  const pausing = running && (pauseAsked || profiles.pausing)
  const records = counting ? live.records : progress.records
  const patients = counting ? live.patients : progress.patients
  const stats: ConceptCountStepProgress = { done: statsReset && counting ? 0 : profiles.done, total: profiles.total }
  const isDone = (step: ConceptCountStepProgress) => step.total > 0 && step.done === step.total
  const recordsDone = isDone(records)
  const complete = !counting && progress.state === 'complete'
  const partial = !counting && progress.state === 'partial'
  const progressOf = { records, patients, stats }

  const chosen = STEPS.filter((s) => countable[s] && picked.has(s))
  // A count the dictionaries hold: in the list already, its toggle on and locked.
  const held = (s: Step) => s !== 'stats' && !countable[s]
  const stepPending = (s: Step) => (s === 'stats' ? !profiles.current : !isDone(progressOf[s]))
  const pending = chosen.filter(stepPending)
  const toggleStep = (step: Step, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(step)
    else next.delete(step)
    setTicked({ dataSourceId, steps: next })
  }

  // Loaded, the card is one line, its options opened on demand; a finished
  // count's line, once closed, stays closed until the session ends or another
  // count finishes.
  const [expanded, setExpanded] = useState(false)
  const [completeDismissed, dismissComplete] = useSessionDismissal(
    `concept-count-complete:${dataSourceId}:${progress.finishedAt}:${profiles.summary?.lastComputedAt ?? ''}`,
  )

  const stepStatus = (step: ConceptCountStepProgress, active: boolean): RunStepStatus =>
    step.total > 0 && step.done === step.total ? 'done' : active ? 'active' : 'pending'
  // The steps asked for, and those already under way.
  const steps: RunStepItem[] = STEPS.filter((s) => countable[s] && (picked.has(s) || progressOf[s].done > 0)).map((s) => ({
    id: s,
    label: t(`concepts.count_step_${s}`),
    status: stepStatus(progressOf[s], s === 'stats' ? profiles.running : counting && live.phase === s),
    progress: progressOf[s],
    ...(s === 'stats' && profiles.preparing ? { detail: t('concepts.profiles_preparing') } : {}),
    ...(s === 'stats' && profiles.share != null
      ? { share: profiles.share, eta: profiles.eta, shareHint: [t('concepts.profiles_share_hint'), profiles.eta != null ? t('concepts.profiles_eta_hint') : null].filter(Boolean).join(' ') }
      : {}),
    ...(counting && live.phase === s ? { startedAt: live.phaseStartedAt, reading: live.reading } : {}),
  }))
  const counted = records.done + patients.done > 0
  // Nothing to list until loaded: the card says so in the warning tone, alone.
  const notLoaded = count.enabled && count.checked && !count.exists
  if (counting && live.phase === 'planning') {
    steps.push({
      id: live.phase,
      label: t('concepts.count_phase_planning'),
      status: 'active',
      startedAt: live.phaseStartedAt,
      ...(live.planningStep ? { detail: t(`concepts.count_planning_${live.planningStep}`) } : {}),
    })
  } else if (counting && live.phase === 'assembling') {
    steps.push({ id: live.phase, label: t('concepts.count_phase_assembling'), status: 'active' })
  }

  const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '')
  const statusText = pausing
    ? t('concepts.count_pausing_detail')
    : counting
    ? t('concepts.count_running')
    : profiles.running || profiles.starting
      ? t('concepts.profiles_running')
      // Paused before anything was assembled counts as never loaded.
      : !listed
        ? t('concepts.cache_none')
        : complete
          ? (profiles.finished ? t('concepts.count_complete_stats', { date: date(profiles.summary?.lastComputedAt ?? progress.finishedAt) }) : t('concepts.count_complete', { date: date(progress.finishedAt) }))
          : !counted
            ? t('concepts.cache_loaded', { date: date(count.refreshedAt) })
            : recordsDone && patients.done === 0 ? t('concepts.count_records_done') : t('concepts.count_paused')

  const start = (restart: boolean) => {
    const countSteps = chosen.filter((s): s is ConceptCountStep => s !== 'stats')
    const withStats = chosen.includes('stats') && (restart || stepPending('stats'))
    if (!count.enabled) {
      if (withStats) void profiles.start({ resume: !restart && profiles.resumable, fresh: restart })
      return
    }
    // Server mode: one run on the server, the counts first — the statistics
    // rank the concepts by what they counted — then the statistics.
    if (!restart && profiles.server?.resumable) {
      void profiles.server.resume().catch(() => {})
      return
    }
    const withCounts = restart || !count.exists || countSteps.some(stepPending)
    setStatsReset(restart && withStats)
    void profiles.startOnServer({
      fresh: restart,
      stats: withStats,
      counts: withCounts
        ? () => prepareCountSpec(
          { dataSourceId, mapping: schemaMapping, restart, steps: countSteps, stats: withStats ? { fresh: restart } : null },
          new AbortController().signal,
        )
        : null,
    })
  }
  const pause = () => {
    if (!count.enabled && !profiles.running) return
    setPauseAsked(true)
    profiles.pause().catch(() => setPauseAsked(false))
  }
  // Begun and stopped short: resumed from the card's line itself, not only
  // from its options.
  const resumable = pending.some((s) => (s === 'stats' ? profiles.resumable : progressOf[s].done > 0))
  const startLabel = !listed ? t('concepts.count_start')
    : pending.length === 0 ? t('concepts.count_again')
      : resumable ? t('concepts.count_resume') : t('concepts.count_continue')
  const stepCard = (step: Step) => {
    const Icon = STEP_ICONS[step]
    const on = held(step) || picked.has(step)
    const id = `concept-step-${step}`
    const sectionOptions = profiles.offered.map((key) => ({
      value: key,
      label: t(`concept_mapping.extract_section_${key}`),
      group: t(`concept_mapping.extract_group_${SECTION_GROUPS[key]}`),
    }))
    return (
      <div
        key={step}
        className={cn(
          'flex flex-col gap-2 rounded-lg border p-4 transition-colors',
          on ? 'border-foreground/25 bg-muted/40' : 'bg-card hover:bg-muted/40',
        )}
      >
        <label htmlFor={id} className={cn('flex items-center gap-2', held(step) ? 'cursor-default' : 'cursor-pointer')}>
          <span className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            on ? 'bg-foreground/10 text-foreground' : 'bg-muted text-muted-foreground',
          )}>
            <Icon size={15} />
          </span>
          <span className="text-sm font-medium">{t(`concepts.count_scope_${step}`)}</span>
          <FieldInfo text={t(held(step) ? 'concepts.count_scope_held_hint' : `concepts.count_scope_${step}_hint`)} />
          <Switch
            id={id}
            className="ml-auto"
            checked={on}
            disabled={held(step)}
            onCheckedChange={(v) => toggleStep(step, v)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {t(held(step) ? 'concepts.count_scope_held' : `concepts.count_scope_${step}_cost`)}
        </p>
        {step === 'stats' && on && (
          <div className="grid gap-1.5 pt-1">
            <Label>{t('concepts.profiles_sections')}</Label>
            <MultiSelectFilter
              value={profiles.sections}
              options={sectionOptions}
              placeholder={t('concepts.profiles_sections')}
              onChange={(v) => profiles.setSections(v as SectionKey[])}
              showChevron
              popoverWidthClass="w-72"
              triggerClass={MULTI_SELECT_FORM_TRIGGER}
            />
          </div>
        )}
      </div>
    )
  }

  const options = (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {count.enabled && stepCard('records')}
        {count.enabled && stepCard('patients')}
        {countable.stats && stepCard('stats')}
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="gap-1.5"
          onClick={() => (pending.length === 0 && listed ? setConfirmRestart(true) : start(false))}
          disabled={!count.checked || (picked.has('stats') && profiles.sections.length === 0)}
        >
          <Play size={14} />
          {startLabel}
        </Button>
        {((partial && counted) || (profiles.summary?.count ?? 0) > 0) && (
          <Button variant="destructive" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
            <RotateCcw size={14} />
            {t('concepts.count_restart')}
          </Button>
        )}
      </div>
    </div>
  )

  // The units are batches of queries, not concepts: their count means nothing
  // to a reader, so the line says how far each step is and the hover says in
  // what units.
  const shownSteps = STEPS.filter((s) => progressOf[s].total > 0)
  // The statistics weigh their concepts by records: the busiest come first.
  const fraction = (s: Step) => (s === 'stats' && profiles.share != null ? profiles.share : progressOf[s].done / progressOf[s].total)
  // A server run of several steps says how far it is as its job does: each step a like share.
  const runSteps = running ? profiles.server?.run?.state.steps : undefined
  const percent = runSteps?.length
    ? (runSteps.reduce((sum, s) => sum + s.share, 0) / runSteps.length) * 100
    : shownSteps.length > 0 ? (shownSteps.reduce((sum, s) => sum + fraction(s), 0) / shownSteps.length) * 100 : 0
  const stale = profiles.stale != null && profiles.stale > 0 && (
    <span className="text-xs text-warning-foreground">{t('concepts.profiles_stale', { count: profiles.stale })}</span>
  )
  const stepCounts = (shownSteps.length > 0 || (profiles.summary?.count ?? 0) > 0) && (
    <div className="flex items-center gap-2">
      {shownSteps.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default text-xs tabular-nums text-muted-foreground">
              {shownSteps
                .map((s) => t(`concepts.count_step_percent_${s}`, { percent: Math.floor(fraction(s) * 100) }))
                .join(' · ')}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <ul className="space-y-1">
              {shownSteps.map((s) => (
                <li key={s}>
                  {t(`concepts.count_step_units_${s}`, { done: progressOf[s].done, total: progressOf[s].total })}
                </li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
      {stale}
      {!running && (profiles.summary?.count ?? 0) > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              disabled={profiles.checking}
              onClick={() => void profiles.check()}
              aria-label={t('concepts.profiles_check')}
            >
              <RefreshCw className={profiles.checking ? 'animate-spin' : undefined} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {profiles.stale === 0 ? t('concepts.profiles_up_to_date') : t('concepts.profiles_check_hint')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  const errorText = live.error ?? profiles.error
  const error = errorText && (
    <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
      <AlertCircle size={14} className="mt-px shrink-0" />
      <span className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">{errorText}</span>
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-1.5">
      {/* Not loaded: nothing to list, so the page is the choice of what to load. */}
      {notLoaded && !running && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2">
          <Card className="flex w-full flex-col gap-6 p-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/15">
                <AlertTriangle size={18} className="text-warning" />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">{t('concepts.cache_none')}</span>
                  <FieldInfo text={t('concepts.cache_none_hint')} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(readOnly ? 'concepts.cache_none_read_only' : 'concepts.cache_none_subtitle')}
                </p>
              </div>
            </div>
            {!readOnly && options}
            {error}
          </Card>
        </div>
      )}

      {/* Running: where it stands — the only place a progress bar shows. */}
      {running && (
        <Card className="flex shrink-0 flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{statusText}</span>
            {stepCounts}
          </div>
          <div className="flex items-center gap-3">
            <Progress value={percent} className="flex-1" />
            {!readOnly && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={pause} disabled={pausing}>
                {pausing ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
                {t(pausing ? 'concepts.count_pausing' : 'concepts.count_pause')}
              </Button>
            )}
          </div>
          <RunSteps steps={steps} />
          {error}
        </Card>
      )}

      {/* Loaded: one line, its options opened on demand. */}
      {!running && listed && !(complete && completeDismissed && !errorText) && (
        <Card className="flex shrink-0 flex-col gap-4 px-4 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{statusText}</span>
            <div className="flex items-center gap-2">
              {stepCounts}
              {!readOnly && resumable && !expanded && (
                <Button size="sm" className="gap-1.5" onClick={() => start(false)} disabled={!count.checked || (picked.has('stats') && profiles.sections.length === 0)}>
                  <Play size={14} />
                  {startLabel}
                </Button>
              )}
              {!readOnly && (
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setExpanded((v) => !v)}>
                  {t('concepts.count_options')}
                  {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </Button>
              )}
              {complete && !errorText && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={dismissComplete}
                  aria-label={t('common.close')}
                  title={t('common.close')}
                >
                  <X />
                </Button>
              )}
            </div>
          </div>
          {expanded && !readOnly && <div className="border-t pb-2 pt-4">{options}</div>}
          {error}
        </Card>
      )}

      {!notLoaded && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-card">
          <div className="min-h-0 flex-1">
            <Allotment>
              <Allotment.Pane minSize={400}>
                <ConceptTable
                  concepts={concepts.concepts}
                  totalCount={concepts.totalCount}
                  page={concepts.page}
                  pageSize={concepts.pageSize}
                  totalPages={concepts.totalPages}
                  isLoading={concepts.isLoading}
                  selectedConceptId={selectedConceptId}
                  availableColumns={concepts.availableColumns}
                  filters={concepts.filters}
                  filterOptions={concepts.filterOptions}
                  filterOptionSearch={concepts.filterOptionSearch}
                  sorting={concepts.sorting}
                  columnVisibility={columnVisibility}
                  onColumnVisibilityChange={setColumnVisibility}
                  onFilterChange={concepts.updateFilter}
                  onSortingChange={concepts.updateSorting}
                  onSelect={(id) => setSelectedConceptId((prev) => (prev === id ? null : id))}
                  selectedConceptIds={selectedIds}
                  onSelectedConceptIdsChange={setSelectedIds}
                  onPageChange={concepts.setPage}
                  onPageSizeChange={(size) => {
                    concepts.setPageSize(size)
                    concepts.setPage(0)
                  }}
                />
              </Allotment.Pane>
              <Allotment.Pane minSize={300} preferredSize={380} visible={selectedConceptId !== null}>
                <ConceptDetail
                  concept={concepts.selectedConcept}
                  availableColumns={concepts.availableColumns}
                  stats={concepts.conceptStats}
                  statsLoading={concepts.conceptStatsLoading}
                  statsError={concepts.conceptStatsError}
                  error={concepts.detailError}
                  statsDeferred={concepts.conceptStatsDeferred}
                  onLoadStats={concepts.loadSelectedStats}
                  // Its queries would contend with the run's on the same database.
                  loadStatsBlocked={running ? t('concepts.stats_load_busy') : null}
                  hasValueColumn={hasValueColumn}
                  excludeOutliers={concepts.excludeOutliers}
                  statsEnabled={concepts.statsEnabled}
                  statsSql={statsSql}
                  profile={profile}
                  onClose={() => setSelectedConceptId(null)}
                />
              </Allotment.Pane>
            </Allotment>
          </div>
        </div>
      )}

      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concepts.count_restart_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('concepts.count_restart_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { setConfirmRestart(false); start(true) }}>
              {t('concepts.count_restart')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
