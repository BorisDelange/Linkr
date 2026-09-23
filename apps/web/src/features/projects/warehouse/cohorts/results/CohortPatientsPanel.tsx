import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { LayoutGrid, Lock, Pencil, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useContextRoleStore } from '@/stores/context-role-store'
import { isServerMode } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { databaseBoardKey, usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientChartContext } from '@/features/projects/warehouse/patient-data/PatientChartContext'
import { PatientChartTabBar } from '@/features/projects/warehouse/patient-data/PatientChartTabBar'
import { PatientChartGrid } from '@/features/projects/warehouse/patient-data/PatientChartGrid'
import { AddPatientWidgetDialog } from '@/features/projects/warehouse/patient-data/AddPatientWidgetDialog'
import type { CohortLevel, SchemaMapping } from '@/types'

/** Rows listed at once: a cohort result holds up to 10k, and the filter above
 *  the list is how to reach the rest. */
const LIST_LIMIT = 300

interface CohortPatientsPanelProps {
  dataSourceId: string
  schemaMapping: SchemaMapping
  level: CohortLevel
  /** The rows of the last execution (`id` at the cohort's level, `patient_id`
   *  beside it below patient level). */
  rows: Record<string, unknown>[]
}

interface ListedRow {
  id: string
  patientId: string
  detail: string
}

/**
 * The patients of a cohort's current result, through the database's one patient
 * board — the same tabs and widgets as Patient data, configured once for the
 * database and shared by all its cohorts. Reviewing a result needs no
 * materialised cohort: the list is the last execution's rows.
 */
export function CohortPatientsPanel({ dataSourceId, schemaMapping, level, rows }: CohortPatientsPanelProps) {
  const { t } = useTranslation()
  const key = databaseBoardKey(dataSourceId)
  // The workspace role answers here — there is no project. Read from the store
  // (a stable array), so the context below keeps its identity across renders.
  const permissions = useContextRoleStore((s) => s.workspacePermissions)
  const can = useCallback(
    (permission: string) => !isServerMode() || permissions.includes(permission),
    [permissions],
  )
  const canWrite = can('databases:write')

  const loadDatabaseBoard = usePatientChartStore((s) => s.loadDatabaseBoard)
  const ensureDatabaseBoard = usePatientChartStore((s) => s.ensureDatabaseBoard)
  const loaded = usePatientChartStore((s) => s.loaded && s.activeProjectUid === key)
  const board = usePatientChartStore((s) => s.dashboards.find((d) => d.ownerDataSourceId === dataSourceId))
  const tabs = usePatientChartStore((s) => s.tabs)
  const widgets = usePatientChartStore((s) => s.widgets)
  const activeTabId = usePatientChartStore((s) => (board ? s.activeTabId[board.id] : undefined))
  const selectedRowId = usePatientChartStore((s) =>
    level === 'patient' ? s.selectedPatientId[key]
      : level === 'visit' ? s.selectedVisitId[key]
        : s.selectedVisitDetailId[key],
  ) ?? null
  const setSelectedPatient = usePatientChartStore((s) => s.setSelectedPatient)
  const setSelectedVisit = usePatientChartStore((s) => s.setSelectedVisit)
  const setSelectedVisitDetail = usePatientChartStore((s) => s.setSelectedVisitDetail)

  const [editMode, setEditMode] = useState(false)
  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void loadDatabaseBoard(dataSourceId)
  }, [dataSourceId, loadDatabaseBoard])

  const listed = useMemo<ListedRow[]>(() => rows.map((r) => ({
    id: String(r.id),
    patientId: String(level === 'patient' ? r.id : r.patient_id),
    detail: [r.gender, r.age_at_admission ?? r.age].filter((v) => v != null && v !== '').join(' · '),
  })), [rows, level])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matching = q ? listed.filter((r) => r.id.toLowerCase().includes(q) || r.patientId.toLowerCase().includes(q)) : listed
    return matching.slice(0, LIST_LIMIT)
  }, [listed, filter])

  const select = (row: ListedRow) => {
    setSelectedPatient(key, row.patientId)
    if (level === 'visit') setSelectedVisit(key, row.id)
    if (level === 'visit_detail') setSelectedVisitDetail(key, row.id)
  }

  // Opens on the first row, so the board shows something before any click.
  useEffect(() => {
    if (!selectedRowId && listed[0]) {
      setSelectedPatient(key, listed[0].patientId)
      if (level === 'visit') setSelectedVisit(key, listed[0].id)
      if (level === 'visit_detail') setSelectedVisitDetail(key, listed[0].id)
    }
  }, [selectedRowId, listed, key, level, setSelectedPatient, setSelectedVisit, setSelectedVisitDetail])

  const boardTabs = useMemo(
    () => tabs.filter((tab) => tab.patientDashboardId === board?.id).sort((a, b) => a.displayOrder - b.displayOrder),
    [board?.id, tabs],
  )
  const currentTabId = activeTabId ?? boardTabs[0]?.id
  const tabWidgets = useMemo(
    () => (currentTabId ? widgets.filter((w) => w.tabId === currentTabId) : []),
    [widgets, currentTabId],
  )

  const startConfiguring = async () => {
    await ensureDatabaseBoard(dataSourceId)
    setEditMode(true)
    setAddWidgetOpen(true)
  }

  const boardId = board?.id
  const context = useMemo(() => ({
    projectUid: key,
    boardId,
    dataSourceId,
    schemaMapping,
    can,
    // In server mode, R/Python runs in a project's session; this board has none.
    codeWidgets: !isServerMode(),
  }), [key, boardId, dataSourceId, schemaMapping, can])

  if (!loaded) return null

  return (
    <PatientChartContext.Provider value={context}>
      <Allotment>
        <Allotment.Pane preferredSize={220} minSize={160} maxSize={400}>
          <div className="flex h-full flex-col border-r">
            <div className="relative shrink-0 border-b p-2">
              <Search size={12} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('cohorts.patients_filter')}
                className="h-7 pl-7 text-xs"
              />
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col py-1">
                {shown.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => select(row)}
                    className={cn(
                      'flex flex-col items-start px-3 py-1.5 text-left text-xs hover:bg-accent',
                      row.id === selectedRowId && 'bg-accent font-medium',
                    )}
                  >
                    <span className="font-mono">{row.id}</span>
                    {(level !== 'patient' || row.detail) && (
                      <span className="text-[10px] text-muted-foreground">
                        {[level !== 'patient' ? t('cohorts.patients_patient', { id: row.patientId }) : '', row.detail]
                          .filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>
            {listed.length > shown.length && (
              <p className="shrink-0 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
                {t('cohorts.patients_list_limited', { shown: shown.length, total: listed.length })}
              </p>
            )}
          </div>
        </Allotment.Pane>

        <Allotment.Pane minSize={320}>
          {board && tabWidgets.length > 0 || (board && editMode) ? (
            <div className="flex h-full flex-col overflow-hidden">
              <div className="flex shrink-0 items-center border-b px-3">
                <PatientChartTabBar dashboardId={board.id} editMode={editMode} />
                <div className="ml-auto flex items-center gap-1 py-1">
                  {editMode && (
                    <Button size="xs" className="gap-1" onClick={() => setAddWidgetOpen(true)}>
                      <Plus size={12} />
                      {t('dashboard.add_widget')}
                    </Button>
                  )}
                  <Button
                    variant={editMode ? 'default' : 'ghost'}
                    size="xs"
                    className="gap-1"
                    disabled={!canWrite}
                    onClick={() => setEditMode(!editMode)}
                  >
                    {editMode ? <Lock size={12} /> : <Pencil size={12} />}
                    {editMode ? t('dashboard.lock_layout') : t('dashboard.edit_layout')}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <PatientChartGrid
                  widgets={tabWidgets}
                  tabs={boardTabs}
                  editMode={editMode}
                  hideTitleBars={(board.showWidgetTitles ?? true) === false}
                  widgetSpacing={board.widgetSpacing}
                  fitToHeight={board.fitToHeight ?? true}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex w-full max-w-sm flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 px-4 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
                  <LayoutGrid size={24} className="text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-sm font-medium text-foreground">{t('cohorts.patients_board_empty_title')}</h3>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('cohorts.patients_board_empty_description')}</p>
                <Button size="sm" className="mt-4 gap-1.5" disabled={!canWrite} onClick={() => void startConfiguring()}>
                  <Plus size={14} />
                  {t('dashboard.add_widget')}
                </Button>
              </div>
            </div>
          )}
        </Allotment.Pane>
      </Allotment>

      {board && (
        <AddPatientWidgetDialog
          open={addWidgetOpen}
          onOpenChange={setAddWidgetOpen}
          tabId={currentTabId ?? ''}
          widgetSpacing={board.widgetSpacing}
          fitToHeight={board.fitToHeight ?? true}
        />
      )}
    </PatientChartContext.Provider>
  )
}
