import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Pause, Play, RotateCcw } from 'lucide-react'
import type { VisibilityState } from '@tanstack/react-table'
import type { SchemaMapping } from '@/types/schema-mapping'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { RunSteps, type RunStepItem, type RunStepStatus } from '@/components/ui/run-steps'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConcepts } from '../concepts/use-concepts'
import { ConceptTable } from '../concepts/ConceptTable'
import { DEFAULT_HIDDEN_COLUMNS } from '../concepts/concept-queries'
import { clearConceptCountError } from '../concepts/concept-count-runner'
import type { ConceptCountStepProgress } from '../concepts/concept-count-plan'

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
  const concepts = useConcepts(dataSourceId, schemaMapping)
  const { count } = concepts
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(DEFAULT_HIDDEN_COLUMNS.map((id) => [id, false])),
  )
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  const { live, progress } = count
  const running = live.running
  const records = running ? live.records : progress.records
  const patients = running ? live.patients : progress.patients
  const total = records.total + patients.total
  const doneUnits = records.done + patients.done
  const complete = !running && progress.state === 'complete'
  const partial = !running && progress.state === 'partial'
  const percent = complete ? 100 : total ? (doneUnits / total) * 100 : 0

  const stepStatus = (step: ConceptCountStepProgress, active: boolean): RunStepStatus =>
    step.total > 0 && step.done === step.total ? 'done' : active ? 'active' : 'pending'
  const steps: RunStepItem[] = [
    {
      id: 'records',
      label: t('concepts.count_step_records'),
      status: stepStatus(records, running && live.phase === 'records'),
      progress: records,
    },
    {
      id: 'patients',
      label: t('concepts.count_step_patients'),
      status: stepStatus(patients, running && live.phase === 'patients'),
      progress: patients,
    },
  ]
  if (running && (live.phase === 'planning' || live.phase === 'assembling')) {
    steps.push({ id: live.phase, label: t(`concepts.count_phase_${live.phase}`), status: 'active' })
  }

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '')
  const statusText = running
    ? t('concepts.count_running')
    : complete
      ? t('concepts.count_complete', { date: date(progress.finishedAt) })
      : partial
        ? t('concepts.count_paused')
        : t('concepts.count_none')

  const start = (restart: boolean) => {
    clearConceptCountError(dataSourceId)
    count.start(restart)
  }

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-1.5">
      {count.enabled && (
        <Card className="flex shrink-0 flex-col gap-2 p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{statusText}</span>
            {total > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('concepts.count_steps', {
                  records: records.done,
                  recordsTotal: records.total,
                  patients: patients.done,
                  patientsTotal: patients.total,
                })}
              </span>
            )}
          </div>

          <Progress value={percent} indicatorClassName={complete ? 'bg-foreground' : undefined} />
          {(running || partial) && <RunSteps steps={steps} className="mt-2" />}

          {live.error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span className="min-w-0 break-words">{live.error}</span>
            </div>
          )}

          {!readOnly && (
            <div className="flex items-center gap-2">
              {running ? (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={count.pause}>
                  <Pause size={14} />
                  {t('concepts.count_pause')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => (complete ? setConfirmRestart(true) : start(false))}
                  disabled={!count.checked}
                >
                  <Play size={14} />
                  {partial ? t('concepts.count_resume') : complete ? t('concepts.count_again') : t('concepts.count_start')}
                </Button>
              )}
              {partial && (
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
                  <RotateCcw size={14} />
                  {t('concepts.count_restart')}
                </Button>
              )}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">{t('concepts.count_hint')}</p>
        </Card>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-card">
        <ConceptTable
          concepts={concepts.concepts}
          totalCount={concepts.totalCount}
          page={concepts.page}
          pageSize={concepts.pageSize}
          totalPages={concepts.totalPages}
          isLoading={concepts.isLoading}
          selectedConceptId={null}
          availableColumns={concepts.availableColumns}
          filters={concepts.filters}
          filterOptions={concepts.filterOptions}
          sorting={concepts.sorting}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          onFilterChange={concepts.updateFilter}
          onSortingChange={concepts.updateSorting}
          onSelect={() => {}}
          selectedConceptIds={selectedIds}
          onSelectedConceptIdsChange={setSelectedIds}
          onPageChange={concepts.setPage}
          onPageSizeChange={(size) => {
            concepts.setPageSize(size)
            concepts.setPage(0)
          }}
          emptyMessage={count.enabled && !count.exists ? t('concepts.count_none') : undefined}
        />
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
