import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { AlertCircle, AlertTriangle, BarChart3, ChevronDown, ChevronUp, Pause, Play, RotateCcw, Rows3, Users, X } from 'lucide-react'
import { useSessionDismissal } from '@/hooks/use-session-dismissal'
import type { VisibilityState } from '@tanstack/react-table'
import type { SchemaMapping } from '@/types/schema-mapping'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { FieldInfo } from '@/components/ui/field-info'
import { RunSteps, type RunStepItem, type RunStepStatus } from '@/components/ui/run-steps'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConcepts } from '../concepts/use-concepts'
import { ConceptTable } from '../concepts/ConceptTable'
import { ConceptPickerToolbar } from '../concepts/ConceptPickerToolbar'
import { ConceptDetail } from '../concepts/ConceptDetail'
import { useConceptStatsSql } from '../concepts/use-concept-stats-sql'
import { DEFAULT_HIDDEN_COLUMNS } from '../concepts/concept-queries'
import { clearConceptCountError } from '../concepts/concept-count-runner'
import type { ConceptCountStep, ConceptCountStepProgress } from '../concepts/concept-count-plan'

const STEPS: readonly ConceptCountStep[] = ['records', 'patients', 'stats']
const STEP_ICONS = { records: Rows3, patients: Users, stats: BarChart3 }

interface DatabaseConceptsTabProps {
  dataSourceId: string
  schemaMapping: SchemaMapping
  readOnly?: boolean
}

/**
 * A database's concepts: where they are loaded into Linkr with the counts asked
 * for — run, paused, resumed — for every project and picker that lists them,
 * and the list itself.
 */
export function DatabaseConceptsTab({ dataSourceId, schemaMapping, readOnly = false }: DatabaseConceptsTabProps) {
  const { t, i18n } = useTranslation()
  const concepts = useConcepts(dataSourceId, schemaMapping, 'database')
  const { count } = concepts
  const [confirmRestart, setConfirmRestart] = useState(false)
  // What the user ticked, for this database; untouched, every step. None loads
  // the concepts alone — searchable, not sortable by use.
  const [ticked, setTicked] = useState<{ dataSourceId: string; steps: ReadonlySet<ConceptCountStep> } | null>(null)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(DEFAULT_HIDDEN_COLUMNS.map((id) => [id, false])),
  )
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const { selectedConceptId, setSelectedConceptId } = concepts
  const { hasValueColumn, statsSql } = useConceptStatsSql(
    schemaMapping, concepts.concepts, selectedConceptId, concepts.excludeOutliers,
  )

  const { live, progress, countable } = count
  const picked: ReadonlySet<ConceptCountStep> = ticked?.dataSourceId === dataSourceId ? ticked.steps : new Set(STEPS)
  const running = live.running
  const records = running ? live.records : progress.records
  const patients = running ? live.patients : progress.patients
  const stats = running ? live.stats : progress.stats
  const total = records.total + patients.total + stats.total
  const doneUnits = records.done + patients.done + stats.done
  const isDone = (step: ConceptCountStepProgress) => step.total > 0 && step.done === step.total
  const recordsDone = isDone(records)
  const complete = !running && progress.state === 'complete'
  const partial = !running && progress.state === 'partial'
  const percent = total ? (doneUnits / total) * 100 : 0

  const chosen = STEPS.filter((s) => countable[s] && picked.has(s))
  // A count the dictionaries hold: in the list already, its toggle on and locked.
  const held = (s: ConceptCountStep) => s !== 'stats' && !countable[s]
  const progressOf = { records, patients, stats }
  const pending = chosen.filter((s) => !isDone(progressOf[s]))
  const toggleStep = (step: ConceptCountStep, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(step)
    else next.delete(step)
    // The statistics are cut into units from the row counts.
    if (countable.records && step === 'stats' && on) next.add('records')
    if (step === 'records' && !on) next.delete('stats')
    setTicked({ dataSourceId, steps: next })
  }

  // Loaded, the card is one line, its options opened on demand; a finished
  // count's line, once closed, stays closed until the session ends or another
  // count finishes.
  const [expanded, setExpanded] = useState(false)
  const [completeDismissed, dismissComplete] = useSessionDismissal(
    `concept-count-complete:${dataSourceId}:${progress.finishedAt}:${progress.statsFinishedAt}`,
  )

  const stepStatus = (step: ConceptCountStepProgress, active: boolean): RunStepStatus =>
    step.total > 0 && step.done === step.total ? 'done' : active ? 'active' : 'pending'
  // The steps asked for, and those already under way.
  const steps: RunStepItem[] = STEPS.filter((s) => countable[s] && (picked.has(s) || progressOf[s].done > 0)).map((s) => ({
    id: s,
    label: t(`concepts.count_step_${s}`),
    status: stepStatus(progressOf[s], running && live.phase === s),
    progress: progressOf[s],
    ...(live.phase === s ? { startedAt: live.phaseStartedAt, reading: live.reading } : {}),
  }))
  const counted = records.done + patients.done > 0
  // Nothing to list until loaded: the card says so in the warning tone, alone.
  const notLoaded = count.enabled && count.checked && !count.exists
  if (running && live.phase === 'planning') {
    steps.push({
      id: live.phase,
      label: t('concepts.count_phase_planning'),
      status: 'active',
      startedAt: live.phaseStartedAt,
      ...(live.planningStep ? { detail: t(`concepts.count_planning_${live.planningStep}`) } : {}),
    })
  } else if (running && live.phase === 'assembling') {
    steps.push({ id: live.phase, label: t('concepts.count_phase_assembling'), status: 'active' })
  }

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '')
  const statusText = running
    ? t('concepts.count_running')
    // Paused before anything was assembled counts as never loaded.
    : !count.exists
      ? t('concepts.cache_none')
      : complete
        ? (isDone(stats) ? t('concepts.count_complete_stats', { date: date(progress.finishedAt) }) : t('concepts.count_complete', { date: date(progress.finishedAt) }))
        : !counted
          ? t('concepts.cache_loaded', { date: date(count.refreshedAt) })
          : recordsDone && patients.done === 0 ? t('concepts.count_records_done') : t('concepts.count_paused')

  const start = (restart: boolean) => {
    clearConceptCountError(dataSourceId)
    count.start(restart, chosen)
  }
  const startLabel = !count.exists ? t('concepts.count_start')
    : pending.length === 0 ? t('concepts.count_again')
      : pending.some((s) => progressOf[s].done > 0) ? t('concepts.count_resume') : t('concepts.count_continue')
  const stepCard = (step: ConceptCountStep) => {
    const Icon = STEP_ICONS[step]
    const on = held(step) || picked.has(step)
    const id = `concept-step-${step}`
    return (
      <label
        key={step}
        htmlFor={id}
        className={cn(
          'flex flex-col gap-2 rounded-lg border p-4 transition-colors',
          on ? 'border-foreground/25 bg-muted/40' : 'bg-card hover:bg-muted/40',
          held(step) ? 'cursor-default' : 'cursor-pointer',
        )}
      >
        <div className="flex items-center gap-2">
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
        </div>
        <p className="text-xs text-muted-foreground">
          {t(held(step) ? 'concepts.count_scope_held' : `concepts.count_scope_${step}_cost`)}
        </p>
      </label>
    )
  }

  const options = (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {stepCard('records')}
        {stepCard('patients')}
        {countable.stats && stepCard('stats')}
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="gap-1.5"
          onClick={() => (pending.length === 0 && count.exists ? setConfirmRestart(true) : start(false))}
          disabled={!count.checked}
        >
          <Play size={14} />
          {startLabel}
        </Button>
        {partial && counted && (
          <Button variant="ghost" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
            <RotateCcw size={14} />
            {t('concepts.count_restart')}
          </Button>
        )}
      </div>
    </div>
  )

  const stepCounts = total > 0 && (
    <span className="text-xs tabular-nums text-muted-foreground">
      {t(stats.total > 0 ? 'concepts.count_steps_stats' : 'concepts.count_steps', {
        records: records.done,
        recordsTotal: records.total,
        patients: patients.done,
        patientsTotal: patients.total,
        stats: stats.done,
        statsTotal: stats.total,
      })}
    </span>
  )

  const error = live.error && (
    <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
      <AlertCircle size={14} className="mt-px shrink-0" />
      <span className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">{live.error}</span>
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-1.5">
      {/* Not loaded: nothing to list, so the page is the choice of what to load. */}
      {notLoaded && !running && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2">
          <Card className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
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
      {count.enabled && running && (
        <Card className="flex shrink-0 flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{statusText}</span>
            {stepCounts}
          </div>
          <div className="flex items-center gap-3">
            <Progress value={percent} className="flex-1" />
            {!readOnly && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={count.pause}>
                <Pause size={14} />
                {t('concepts.count_pause')}
              </Button>
            )}
          </div>
          <RunSteps steps={steps} />
          {error}
        </Card>
      )}

      {/* Loaded: one line, its options opened on demand. */}
      {count.enabled && !running && count.exists && !(complete && completeDismissed && !live.error) && (
        <Card className="flex shrink-0 flex-col gap-4 px-4 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{statusText}</span>
            <div className="flex items-center gap-2">
              {stepCounts}
              {!readOnly && (
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setExpanded((v) => !v)}>
                  {t('concepts.count_options')}
                  {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </Button>
              )}
              {complete && !live.error && (
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
          {/* Over every field — name, code, id — tolerant of typos and accents;
              the Name column's own filter covers the name alone. */}
          <ConceptPickerToolbar
            availableColumns={concepts.availableColumns}
            filters={concepts.filters}
            filterOptions={concepts.filterOptions}
            onFilterChange={concepts.updateFilter}
          />
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
                  hasValueColumn={hasValueColumn}
                  excludeOutliers={concepts.excludeOutliers}
                  statsEnabled={concepts.statsEnabled}
                  statsSql={statsSql}
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
            <AlertDialogAction onClick={() => { setConfirmRestart(false); start(true) }}>
              {t('concepts.count_restart')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
