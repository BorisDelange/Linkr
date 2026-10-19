import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { AlertCircle, ChevronDown, ChevronUp, Pause, Play, RotateCcw, X } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
import { useSessionDismissal } from '@/hooks/use-session-dismissal'
import type { VisibilityState } from '@tanstack/react-table'
import type { SchemaMapping } from '@/types/schema-mapping'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RunSteps, type RunStepItem, type RunStepStatus } from '@/components/ui/run-steps'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConcepts, type ConceptRow } from '../concepts/use-concepts'
import { ConceptTable } from '../concepts/ConceptTable'
import { ConceptPickerToolbar } from '../concepts/ConceptPickerToolbar'
import { ConceptDetail } from '../concepts/ConceptDetail'
import { ConceptStatsPopover } from '../concepts/ConceptStatsPopover'
import { useConceptStatsSql } from '../concepts/use-concept-stats-sql'
import { DEFAULT_HIDDEN_COLUMNS } from '../concepts/concept-queries'
import { clearConceptCountError } from '../concepts/concept-count-runner'
import type { ConceptCountStep, ConceptCountStepProgress } from '../concepts/concept-count-plan'

/** What a count may run besides the rows, which it always counts. */
type OptionalStep = Exclude<ConceptCountStep, 'records'>

interface DatabaseConceptsTabProps {
  dataSourceId: string
  schemaMapping: SchemaMapping
  readOnly?: boolean
}

/**
 * A database's concepts: where their counts are computed — run, paused,
 * resumed — for every project and picker that lists them, and the list itself.
 */
export function DatabaseConceptsTab({ dataSourceId, schemaMapping, readOnly = false }: DatabaseConceptsTabProps) {
  const { t, i18n } = useTranslation()
  const concepts = useConcepts(dataSourceId, schemaMapping, 'database')
  const { count } = concepts
  const [confirmRestart, setConfirmRestart] = useState(false)
  // What the user ticked, for this database; untouched, the steps the stored
  // run computed. Rows alone take one pass per table — seconds — and make the
  // list sortable by use; patients are the long part, and the statistics an
  // extra, so a database never counted starts with rows and patients.
  const [ticked, setTicked] = useState<{ dataSourceId: string; steps: ReadonlySet<OptionalStep> } | null>(null)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(DEFAULT_HIDDEN_COLUMNS.map((id) => [id, false])),
  )
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const { selectedConceptId, setSelectedConceptId } = concepts
  // Stable identity: ConceptTable rebuilds its columns whenever `rowAction` changes.
  const defaultDictKey = schemaMapping.concepts?.[0]?.key ?? ''
  const rowAction = useMemo(
    () => ({
      render: (row: ConceptRow) => (
        <ConceptStatsPopover
          dataSourceId={dataSourceId}
          schemaMapping={schemaMapping}
          conceptId={row.concept_id}
          dictKey={(row._dict_key as string) ?? defaultDictKey}
        />
      ),
    }),
    [dataSourceId, schemaMapping, defaultDictKey],
  )
  const { hasValueColumn, statsSql } = useConceptStatsSql(
    schemaMapping, concepts.concepts, selectedConceptId, concepts.excludeOutliers,
  )

  const { live, progress } = count
  const extra: ReadonlySet<OptionalStep> = ticked?.dataSourceId === dataSourceId
    ? ticked.steps
    : new Set<OptionalStep>([
      ...(progress.state === 'none' || progress.patients.done > 0 ? ['patients' as const] : []),
      ...(progress.stats.total > 0 ? ['stats' as const] : []),
    ])
  const running = live.running
  const records = running ? live.records : progress.records
  const patients = running ? live.patients : progress.patients
  const stats = running ? live.stats : progress.stats
  const total = records.total + patients.total + stats.total
  const doneUnits = records.done + patients.done + stats.done
  const isDone = (step: ConceptCountStepProgress) => step.total > 0 && step.done === step.total
  const recordsDone = isDone(records)
  const statsPartial = stats.total > 0 && !isDone(stats)
  const complete = !running && progress.state === 'complete'
  const partial = !running && progress.state === 'partial'
  const percent = complete && !statsPartial ? 100 : total ? (doneUnits / total) * 100 : 0

  const chosen: ConceptCountStep[] = ['records', ...(['patients', 'stats'] as const).filter(
    (s) => extra.has(s) && (s !== 'stats' || count.hasStats),
  )]
  const progressOf = { records, patients, stats }
  const pending = chosen.filter((s) => !isDone(progressOf[s]))
  const toggleStep = (step: OptionalStep, on: boolean) => {
    const next = new Set(extra)
    if (on) next.add(step)
    else next.delete(step)
    setTicked({ dataSourceId, steps: next })
  }
  const startSteps = () => chosen.filter((s): s is OptionalStep => s !== 'records')

  // A finished count is one line, opened on demand; closed, it stays closed
  // until the session ends or another count finishes.
  const [expanded, setExpanded] = useState(false)
  const [completeDismissed, dismissComplete] = useSessionDismissal(
    `concept-count-complete:${dataSourceId}:${progress.finishedAt}:${progress.statsFinishedAt}`,
  )
  const compact = complete && !statsPartial && !expanded && !live.error

  const stepStatus = (step: ConceptCountStepProgress, active: boolean): RunStepStatus =>
    step.total > 0 && step.done === step.total ? 'done' : active ? 'active' : 'pending'
  const steps: RunStepItem[] = [
    {
      id: 'records',
      label: t('concepts.count_step_records'),
      status: stepStatus(records, running && live.phase === 'records'),
      progress: records,
      ...(live.phase === 'records' ? { startedAt: live.phaseStartedAt, reading: live.reading } : {}),
    },
    {
      id: 'patients',
      label: t('concepts.count_step_patients'),
      status: stepStatus(patients, running && live.phase === 'patients'),
      progress: patients,
      ...(live.phase === 'patients' ? { startedAt: live.phaseStartedAt, reading: live.reading } : {}),
    },
  ]
  if (count.hasStats && (stats.total > 0 || extra.has('stats'))) {
    steps.push({
      id: 'stats',
      label: t('concepts.count_step_stats'),
      status: stepStatus(stats, running && live.phase === 'stats'),
      progress: stats,
      ...(live.phase === 'stats' ? { startedAt: live.phaseStartedAt, reading: live.reading } : {}),
    })
  }
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
    : complete
      ? (isDone(stats) ? t('concepts.count_complete_stats', { date: date(progress.finishedAt) }) : t('concepts.count_complete', { date: date(progress.finishedAt) }))
      // Paused before anything was assembled: no list yet, so no counts and a strict search.
      : partial && count.exists
        ? (recordsDone && patients.done === 0 ? t('concepts.count_records_done') : t('concepts.count_paused'))
        : t('concepts.count_none')

  const start = (restart: boolean) => {
    clearConceptCountError(dataSourceId)
    count.start(restart, startSteps())
  }
  const startLabel = pending.length === 0 ? t('concepts.count_again')
    : progress.state === 'none' ? t('concepts.count_start')
      : pending.some((s) => progressOf[s].done > 0) ? t('concepts.count_resume') : t('concepts.count_continue')
  const stepLabel = (step: ConceptCountStep) => t(`concepts.count_scope_${step}`)

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-1.5">
      {count.enabled && !(complete && completeDismissed && !live.error) && (
        <Card className={compact ? 'flex shrink-0 flex-col px-4 py-1.5' : 'flex shrink-0 flex-col gap-2 p-5'}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{statusText}</span>
            <div className="flex items-center gap-1">
              {total > 0 && !compact && (
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
              )}
              {complete && !live.error && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-2 text-muted-foreground"
                    onClick={() => setExpanded((v) => !v)}
                    aria-label={expanded ? t('common.hide_details') : t('common.show_details')}
                    title={expanded ? t('common.hide_details') : t('common.show_details')}
                  >
                    {expanded ? <ChevronUp /> : <ChevronDown />}
                  </Button>
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
                </>
              )}
            </div>
          </div>

          {!compact && <div className="flex items-center gap-2">
            <Progress value={percent} className="flex-1" indicatorClassName={complete ? 'bg-foreground' : undefined} />
            {!readOnly && (
              <>
                {running ? (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={count.pause}>
                    <Pause size={14} />
                    {t('concepts.count_pause')}
                  </Button>
                ) : (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="w-52 justify-between gap-1.5 font-normal">
                          <span className="truncate">{chosen.map(stepLabel).join(', ')}</span>
                          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" density="compact" className="w-52">
                        {/* The rows are what every other step reads: always counted. */}
                        <DropdownMenuCheckboxItem checked disabled>{stepLabel('records')}</DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={extra.has('patients')}
                          onCheckedChange={(on) => toggleStep('patients', on === true)}
                          onSelect={(e) => e.preventDefault()}
                        >
                          {stepLabel('patients')}
                        </DropdownMenuCheckboxItem>
                        {count.hasStats && (
                          <DropdownMenuCheckboxItem
                            checked={extra.has('stats')}
                            onCheckedChange={(on) => toggleStep('stats', on === true)}
                            onSelect={(e) => e.preventDefault()}
                          >
                            {stepLabel('stats')}
                          </DropdownMenuCheckboxItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => (pending.length === 0 ? setConfirmRestart(true) : start(false))}
                      disabled={!count.checked}
                    >
                      <Play size={14} />
                      {startLabel}
                    </Button>
                  </>
                )}
                {partial && (
                  <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
                    <RotateCcw size={14} />
                    {t('concepts.count_restart')}
                  </Button>
                )}
              </>
            )}
          </div>}
          {(running || partial || statsPartial) && <RunSteps steps={steps} className="mt-2" />}
          {live.error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">{live.error}</span>
            </div>
          )}
        </Card>
      )}

      {count.held && isServerMode() && (
        <NoticeBanner tone="warning" title={t('concepts.count_held')} description={t('concepts.search_strict')} className="shrink-0" />
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-card">
        {/* Over every field — name, code, id — and, once the list is cached,
            tolerant of typos and accents; the Name column's own filter covers
            the name alone. */}
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
                rowAction={rowAction}
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
