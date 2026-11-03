import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment, LayoutPriority } from 'allotment'
import 'allotment/dist/style.css'
import { LayoutGrid, Loader2, Lock, Pencil, Plus, Settings2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { planCohortBoard } from './cohort-board-plan'
import { EmptyState } from '@/components/ui/empty-state'
import { useContextRoleStore } from '@/stores/context-role-store'
import { isServerMode } from '@/lib/api-client'
import { runMaterialization } from '@/lib/cohort-materialization'
import { cohortBoardKey, usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientChartContext } from '@/features/projects/warehouse/patient-data/PatientChartContext'
import { PatientChartTabBar } from '@/features/projects/warehouse/patient-data/PatientChartTabBar'
import { BoardTabGrids } from '@/features/projects/warehouse/patient-data/BoardTabGrids'
import { AddPatientWidgetDialog } from '@/features/projects/warehouse/patient-data/AddPatientWidgetDialog'
import { PatientDataSettingsDialog } from '@/features/projects/warehouse/patient-data/PatientDataSettingsDialog'
import { PatientDataSidebar } from '@/features/projects/warehouse/patient-data/PatientDataSidebar'
import { useFullscreen } from '@/hooks/use-fullscreen'
import { FullscreenButton } from '@/components/ui/fullscreen-button'
import { PortalContainerProvider } from '@/lib/portal-container'
import type { Cohort, SchemaMapping } from '@/types'

interface CohortPatientsPanelProps {
  /** The database the cohort runs on, which its board reads. */
  dataSourceId: string
  /** A project cohort (`projectUid`) or a database's own: its board lives with it. */
  cohort: Cohort
  schemaMapping: SchemaMapping
  /** The rows of the last execution (`id` at the cohort's level, `patient_id`
   *  beside it below patient level); null before any — the board is then shown
   *  with its widgets paused, to rearrange or remove them without running them. */
  rows: Record<string, unknown>[] | null
  /** The cohort's size in that execution: more than its rows when they were capped. */
  total?: number
}

/**
 * The patients of a cohort's current result, through the cohort's own patient
 * board — the same tabs and widgets as Patient data, but one per cohort and not
 * among the project's Patient data boards. Reviewing a result needs no
 * materialised cohort: the list is the last execution's rows.
 */
export function CohortPatientsPanel({ dataSourceId, cohort, schemaMapping, rows, total }: CohortPatientsPanelProps) {
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
  const [generateOpen, setGenerateOpen] = useState(false)
  const replaceTabsWithWidgets = usePatientChartStore((s) => s.replaceTabsWithWidgets)
  const { ref: fullscreenRef, isFullscreen, toggle: toggleFullscreen, portalContainer: fullscreenContainer } = useFullscreen()

  useEffect(() => {
    void loadCohortBoard({ dataSourceId, projectUid }, cohort.id)
  }, [dataSourceId, projectUid, cohort.id, loadCohortBoard])

  // The last execution's patients, handed to the sidebar as a frozen membership:
  // what is listed is what ran, whatever the criteria have become since — and
  // whatever the cohort is written in (custom SQL, a unit-stay level). A run
  // that kept only its first rows lists from the criteria, every member.
  const listedCohort = useMemo<Cohort>(() => {
    const materialization = runMaterialization(cohort.id, level, rows ?? [], total ?? rows?.length ?? 0)
    return materialization ? { ...cohort, materialization } : cohort
  }, [cohort, rows, total, level])

  const boardTabs = useMemo(
    () => tabs.filter((tab) => tab.patientDashboardId === board?.id).sort((a, b) => a.displayOrder - b.displayOrder),
    [board?.id, tabs],
  )
  const currentTabId = activeTabId ?? boardTabs[0]?.id
  // A board holding nothing yet (its first tab, empty) is replaced without asking.
  const boardHasWidgets = useMemo(() => {
    const ids = new Set(boardTabs.map((tab) => tab.id))
    return widgets.some((w) => ids.has(w.tabId))
  }, [boardTabs, widgets])

  const startConfiguring = async () => {
    await ensureCohortBoard({ dataSourceId, projectUid }, cohort.id)
    setEditMode(true)
    setAddWidgetOpen(true)
  }

  // The tabs the criteria call for, in place of whatever the board has.
  const plan = useMemo(() => planCohortBoard(cohort, schemaMapping, t), [cohort, schemaMapping, t])
  const generateTabs = async () => {
    setGenerateOpen(false)
    const id = board?.id ?? await ensureCohortBoard({ dataSourceId, projectUid }, cohort.id)
    replaceTabsWithWidgets(id, plan)
  }

  const boardId = board?.id
  const paused = rows === null
  const context = useMemo(() => ({
    projectUid: selectionKey,
    boardId,
    dataSourceId,
    schemaMapping,
    can,
    // In server mode, R/Python runs in a project's session: only a project's
    // board has one.
    codeWidgets: inProject || !isServerMode(),
    paused,
  }), [selectionKey, boardId, dataSourceId, schemaMapping, can, inProject, paused])

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={14} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  const emptyBoard = (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={LayoutGrid}
        title={t('cohorts.patients_board_empty_title')}
        description={t('cohorts.patients_board_empty_description')}
        action={
          <div className="flex gap-2">
            <Button size="sm" className="gap-1.5" disabled={!canWrite} onClick={() => void generateTabs()}>
              <Wand2 size={14} />
              {t('cohorts.board_generate')}
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={!canWrite} onClick={() => void startConfiguring()}>
              <Plus size={14} />
              {t('dashboard.add_widget')}
            </Button>
          </div>
        }
      />
    </div>
  )

  return (
    <PatientChartContext.Provider value={context}>
      <PortalContainerProvider value={fullscreenContainer}>
      <div ref={fullscreenRef} className="h-full bg-background">
      {/* Not proportional: folding the builder's pane widens this one, and that
          width goes to the board — the sidebar keeps its pixels. */}
      <Allotment proportionalLayout={false}>
        <Allotment.Pane minSize={320} priority={LayoutPriority.High}>
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="gap-1"
                        disabled={!canWrite}
                        onClick={() => (boardHasWidgets ? setGenerateOpen(true) : void generateTabs())}
                      >
                        <Wand2 size={13} />
                        {t('cohorts.board_generate')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-72">{t('cohorts.board_generate_hint')}</TooltipContent>
                  </Tooltip>
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
                  <FullscreenButton isFullscreen={isFullscreen} onToggle={toggleFullscreen} />
                </div>
              </div>
              {/* The tab bar stays on an empty tab: it is how to reach the others. */}
              <div className="min-h-0 flex-1 overflow-hidden">
                <BoardTabGrids
                  board={board}
                  tabs={boardTabs}
                  widgets={widgets}
                  currentTabId={currentTabId}
                  editMode={editMode}
                  empty={emptyBoard}
                />
              </div>
            </div>
          ) : (
            emptyBoard
          )}
        </Allotment.Pane>
        {/* The patient sidebar of a project's boards, on the same side. */}
        <Allotment.Pane preferredSize={320} minSize={220} maxSize={480} priority={LayoutPriority.Low}>
          <PatientDataSidebar cohort={listedCohort} />
        </Allotment.Pane>
      </Allotment>

      <AlertDialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.board_generate_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohorts.board_generate_description', { count: plan.length, tabs: plan.map((p) => p.name).join(', ') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void generateTabs()}>
              {t('cohorts.board_generate_replace')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
      </div>
      </PortalContainerProvider>
    </PatientChartContext.Provider>
  )
}
