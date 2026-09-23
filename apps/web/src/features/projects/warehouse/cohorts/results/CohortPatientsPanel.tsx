import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { LayoutGrid, Lock, Pencil, Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useContextRoleStore } from '@/stores/context-role-store'
import { isServerMode } from '@/lib/api-client'
import { cohortBoardKey, usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientChartContext } from '@/features/projects/warehouse/patient-data/PatientChartContext'
import { PatientChartTabBar } from '@/features/projects/warehouse/patient-data/PatientChartTabBar'
import { PatientChartGrid } from '@/features/projects/warehouse/patient-data/PatientChartGrid'
import { AddPatientWidgetDialog } from '@/features/projects/warehouse/patient-data/AddPatientWidgetDialog'
import { PatientDataSettingsDialog } from '@/features/projects/warehouse/patient-data/PatientDataSettingsDialog'
import { PatientDataSidebar } from '@/features/projects/warehouse/patient-data/PatientDataSidebar'
import type { Cohort, SchemaMapping } from '@/types'

interface CohortPatientsPanelProps {
  /** The database the cohort runs on, which its board reads. */
  dataSourceId: string
  /** A project cohort (`projectUid`) or a database's own: its board lives with it. */
  cohort: Cohort
  schemaMapping: SchemaMapping
  /** The rows of the last execution (`id` at the cohort's level, `patient_id`
   *  beside it below patient level). */
  rows: Record<string, unknown>[]
}

/**
 * The patients of a cohort's current result, through the cohort's own patient
 * board — the same tabs and widgets as Patient data, but one per cohort and not
 * among the project's Patient data boards. Reviewing a result needs no
 * materialised cohort: the list is the last execution's rows.
 */
export function CohortPatientsPanel({ dataSourceId, cohort, schemaMapping, rows }: CohortPatientsPanelProps) {
  const { t } = useTranslation()
  const { level, projectUid } = cohort
  const inProject = !!projectUid
  const key = cohortBoardKey(cohort.id)
  // What the widgets read the selected patient under, and resolve the project
  // by (its datasets, concept lists, code sessions): a project cohort is still
  // in its project, so that is the project's uid; a database cohort has none.
  const selectionKey = projectUid ?? key
  // A project cohort answers to the project's role; a database cohort to the
  // workspace's — there is no project. Read from the store (stable arrays), so
  // the context below keeps its identity across renders.
  const permissions = useContextRoleStore((s) => (inProject ? s.projectPermissions : s.workspacePermissions))
  const can = useCallback(
    (permission: string) => !isServerMode() || permissions.includes(permission),
    [permissions],
  )
  const canWrite = can(inProject ? 'patient-data:write' : 'databases:write')

  const loadCohortBoard = usePatientChartStore((s) => s.loadCohortBoard)
  const ensureCohortBoard = usePatientChartStore((s) => s.ensureCohortBoard)
  const loaded = usePatientChartStore((s) => s.loaded && s.activeProjectUid === key)
  const board = usePatientChartStore((s) => s.dashboards.find((d) => d.ownerCohortId === cohort.id))
  const tabs = usePatientChartStore((s) => s.tabs)
  const widgets = usePatientChartStore((s) => s.widgets)
  const activeTabId = usePatientChartStore((s) => (board ? s.activeTabId[board.id] : undefined))

  const [editMode, setEditMode] = useState(false)
  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void loadCohortBoard({ dataSourceId, projectUid }, cohort.id)
  }, [dataSourceId, projectUid, cohort.id, loadCohortBoard])

  // The last execution's patients, handed to the sidebar as a frozen membership:
  // what is listed is what ran, whatever the criteria have become since — and
  // whatever the cohort is written in (custom SQL, a unit-stay level).
  const listedCohort = useMemo<Cohort>(() => {
    const ids = rows.map((r) => String(r.id))
    const patientIds = [...new Set(rows.map((r) => String(level === 'patient' ? r.id : r.patient_id)))]
    return {
      ...cohort,
      materialization: {
        level,
        ids,
        patientIds,
        count: ids.length,
        // Stands for this run: the sidebar re-reads its pages when it changes.
        materializedAt: `${ids.length}:${ids[0] ?? ''}:${ids[ids.length - 1] ?? ''}`,
      },
    }
  }, [cohort, rows, level])

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
    await ensureCohortBoard({ dataSourceId, projectUid }, cohort.id)
    setEditMode(true)
    setAddWidgetOpen(true)
  }

  const boardId = board?.id
  const context = useMemo(() => ({
    projectUid: selectionKey,
    boardId,
    dataSourceId,
    schemaMapping,
    can,
    // In server mode, R/Python runs in a project's session: only a project's
    // board has one.
    codeWidgets: inProject || !isServerMode(),
  }), [selectionKey, boardId, dataSourceId, schemaMapping, can, inProject])

  if (!loaded) return null

  return (
    <PatientChartContext.Provider value={context}>
      <Allotment>
        <Allotment.Pane minSize={320}>
          {board ? (
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
                    variant="ghost"
                    size="xs"
                    className="gap-1"
                    disabled={!canWrite}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings2 size={13} />
                    {t('patient_data.settings_title')}
                  </Button>
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
              {/* The tab bar stays on an empty tab: it is how to reach the others. */}
              <div className="min-h-0 flex-1 overflow-hidden">
                {tabWidgets.length > 0 ? (
                  <PatientChartGrid
                    widgets={tabWidgets}
                    tabs={boardTabs}
                    editMode={editMode}
                    hideTitleBars={(board.showWidgetTitles ?? true) === false}
                    widgetSpacing={board.widgetSpacing}
                    fitToHeight={board.fitToHeight ?? true}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6">
                    <div className="flex w-full max-w-sm flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 px-4 py-12 text-center">
                      <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
                        <LayoutGrid size={24} className="text-muted-foreground" />
                      </div>
                      <h3 className="mt-4 text-sm font-medium text-foreground">{t('cohorts.patients_board_empty_title')}</h3>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {t('cohorts.patients_board_empty_description')}
                      </p>
                      <Button size="sm" className="mt-4 gap-1.5" disabled={!canWrite} onClick={() => void startConfiguring()}>
                        <Plus size={14} />
                        {t('dashboard.add_widget')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex w-full max-w-sm flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 px-4 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
                  <LayoutGrid size={24} className="text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-sm font-medium text-foreground">{t('cohorts.patients_board_empty_title')}</h3>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('cohorts.patients_board_empty_description')}
                </p>
                <Button size="sm" className="mt-4 gap-1.5" disabled={!canWrite} onClick={() => void startConfiguring()}>
                  <Plus size={14} />
                  {t('dashboard.add_widget')}
                </Button>
              </div>
            </div>
          )}
        </Allotment.Pane>
        {/* The patient sidebar of a project's boards, on the same side. */}
        <Allotment.Pane preferredSize={320} minSize={220} maxSize={480}>
          <PatientDataSidebar cohort={listedCohort} />
        </Allotment.Pane>
      </Allotment>

      {board && (
        <>
          <AddPatientWidgetDialog
            open={addWidgetOpen}
            onOpenChange={setAddWidgetOpen}
            tabId={currentTabId ?? ''}
            widgetSpacing={board.widgetSpacing}
            fitToHeight={board.fitToHeight ?? true}
            fullWidth
          />
          <PatientDataSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} dashboardId={board.id} />
        </>
      )}
    </PatientChartContext.Provider>
  )
}
