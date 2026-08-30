import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Plus, Pencil, Lock, Users, LayoutGrid, Settings2, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip'
import { useDataSourceStore } from '@/stores/data-source-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientChartContext } from './patient-data/PatientChartContext'
import { PatientChartTabBar } from './patient-data/PatientChartTabBar'
import { PatientChartGrid } from './patient-data/PatientChartGrid'
import { TabVisibilityContext } from './patient-data/TabVisibilityContext'
import { PatientDataSidebar } from './patient-data/PatientDataSidebar'
import { AddPatientWidgetDialog } from './patient-data/AddPatientWidgetDialog'
import { PatientDataSettingsDialog } from './patient-data/PatientDataSettingsDialog'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'

export function PatientDataPage() {
  const { t } = useTranslation()
  const { wsUid, projectUid: resolvedUid, raw } = useResolvedParams()
  const navigate = useNavigate()
  const projectUid = resolvedUid ?? ''
  const canWrite = useMyProjectRole(projectUid).can('patient-data:write')
  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)

  const { getActiveSource } = useDataSourceStore()
  const mappedSource = projectUid ? getActiveSource(projectUid) : undefined
  const dataSourceId = mappedSource?.id
  const schemaMapping = mappedSource?.schemaMapping

  // Narrow selectors: a bare usePatientChartStore() re-renders the page (and the
  // whole grid under it) on every patient/visit selection change.
  const dashboards = usePatientChartStore((s) => s.dashboards)
  const tabs = usePatientChartStore((s) => s.tabs)
  const widgets = usePatientChartStore((s) => s.widgets)
  const activeTabId = usePatientChartStore((s) => s.activeTabId)
  const loaded = usePatientChartStore((s) => s.loaded && s.activeProjectUid === projectUid)
  const loadProjectDashboards = usePatientChartStore((s) => s.loadProjectDashboards)
  const setActiveDashboard = usePatientChartStore((s) => s.setActiveDashboard)

  useEffect(() => {
    if (projectUid) loadProjectDashboards(projectUid)
  }, [projectUid, loadProjectDashboards])

  const projectBoards = dashboards
    .filter((d) => d.projectUid === projectUid)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  // The URL carries a short id prefix (see short-id.ts), so resolve it against the
  // project's boards rather than matching the raw param.
  const currentBoard = resolveByIdPrefix(projectBoards, raw.boardId, (d) => d.id)

  useEffect(() => {
    if (currentBoard) setActiveDashboard(projectUid, currentBoard.id)
  }, [projectUid, currentBoard, setActiveDashboard])

  const boardTabs = currentBoard
    ? tabs
        .filter((tab) => tab.patientDashboardId === currentBoard.id)
        .sort((a, b) => a.displayOrder - b.displayOrder)
    : []
  const currentTabId = currentBoard
    ? (activeTabId[currentBoard.id] ?? boardTabs[0]?.id)
    : undefined
  const tabWidgets = currentTabId ? widgets.filter((w) => w.tabId === currentTabId) : []

  // Keep-alive for visited tabs, mirroring DashboardPage: once a tab with widgets is shown,
  // keep its grid mounted (hidden via CSS when inactive) so returning to it doesn't remount —
  // no chart redraw, and already-fetched rows stay live in the DOM. Unvisited tabs are never
  // mounted, so we don't pay for tabs the user never opens.
  //
  // "Reload widgets on tab switch" turns keep-alive OFF: only the current tab is mounted, so
  // leaving a tab frees its DOM and returning refetches it.
  const keepAlive = currentBoard?.reloadWidgetsOnTabSwitch !== true
  const [visitedTabIds, setVisitedTabIds] = useState<Set<string>>(new Set())
  const isMountableTab = !!currentTabId && tabWidgets.length > 0
  // Drop the visited set when the board changes — its tab ids no longer apply.
  useEffect(() => {
    setVisitedTabIds(new Set())
  }, [currentBoard?.id])
  useEffect(() => {
    if (keepAlive && isMountableTab && currentTabId && !visitedTabIds.has(currentTabId)) {
      setVisitedTabIds((prev) => new Set(prev).add(currentTabId))
    }
  }, [keepAlive, isMountableTab, currentTabId, visitedTabIds])
  // With keep-alive: every visited tab (+ the current one on its first render, before the
  // effect records it). Without: only the current tab, so switching away unmounts it.
  const mountedTabs = boardTabs.filter((tab) =>
    keepAlive
      ? visitedTabIds.has(tab.id) || (isMountableTab && tab.id === currentTabId)
      : isMountableTab && tab.id === currentTabId,
  )

  // Each tab's slice keeps a stable reference across tab switches, so a kept-alive grid whose
  // props are otherwise unchanged doesn't re-reconcile its charts on every board render.
  const widgetsByTab = useMemo(() => {
    const m = new Map<string, typeof widgets>()
    for (const w of widgets) {
      const list = m.get(w.tabId)
      if (list) list.push(w)
      else m.set(w.tabId, [w])
    }
    return m
  }, [widgets])
  const emptyWidgets = useMemo<typeof widgets>(() => [], [])

  if (!loaded) return null

  if (!currentBoard) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">{t('patient_data.board_not_found')}</p>
          <Button
            variant="link"
            size="sm"
            className="mt-2"
            onClick={() => navigate(paths.patientData(wsUid ?? '', projectUid))}
          >
            {t('patient_data.back_to_boards')}
          </Button>
        </div>
      </div>
    )
  }

  // No data source
  if (!mappedSource) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-bold text-foreground">
            {t('patient_data.title')}
          </h1>
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Users size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('patient_data.no_data_source')}
              </p>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {t('patient_data.no_data_source_description')}
              </p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  // No patient table in schema
  if (!schemaMapping?.patientTable) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-bold text-foreground">
            {t('patient_data.title')}
          </h1>
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Users size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('patient_data.no_patient_table')}
              </p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <PatientChartContext.Provider
      value={{ projectUid, dataSourceId, schemaMapping }}
    >
      <div className="flex h-full flex-col overflow-hidden">
        {/* Tab bar + actions */}
        <div className="flex items-center border-b px-3 shrink-0">
          <PatientChartTabBar dashboardId={currentBoard.id} editMode={editMode} />

          <TooltipProvider delayDuration={300}>
            <div className="ml-auto flex items-center gap-1 py-1">
              {editMode && (
                <Button
                  size="xs"
                  className="gap-1"
                  onClick={() => setAddWidgetOpen(true)}
                >
                  <Plus size={12} />
                  {t('dashboard.add_widget')}
                </Button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={editMode ? 'default' : 'ghost'}
                    size="xs"
                    className="gap-1"
                    disabled={!canWrite}
                    onClick={() => setEditMode(!editMode)}
                  >
                    {editMode ? (
                      <>
                        <Lock size={12} />
                        {t('dashboard.lock_layout')}
                      </>
                    ) : (
                      <>
                        <Pencil size={12} />
                        {t('dashboard.edit_layout')}
                      </>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {editMode ? t('dashboard.lock_layout_hint') : t('dashboard.edit_layout_hint')}
                </TooltipContent>
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={sidebarVisible ? 'ghost' : 'secondary'}
                    size="icon-xs"
                    onClick={() => setSidebarVisible(!sidebarVisible)}
                  >
                    <PanelRight size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('patient_data.toggle_sidebar')}
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        {/* Main content: dashboard + sidebar */}
        <div className="flex-1 overflow-hidden">
          <Allotment>
            <Allotment.Pane minSize={500}>
              {tabWidgets.length > 0 ? (
                mountedTabs.map((tab) => (
                  <div
                    key={tab.id}
                    // `hidden`, not `invisible`: visibility is inherited but a
                    // descendant can override it, and a Dygraph does — its legend
                    // and range selector are positioned absolutely with a z-index,
                    // so a timeline on a hidden tab stayed painted over the visible
                    // one. display:none cannot be overridden from inside.
                    className={
                      tab.id === currentTabId
                        ? 'contents'
                        : 'hidden absolute top-0 left-0 w-full'
                    }
                    aria-hidden={tab.id !== currentTabId}
                  >
                    {/* Kept-alive tabs stay mounted, and a patient widget refetches
                        on every patient/visit change — so without this a hidden tab
                        would query the warehouse alongside the visible one. */}
                    <TabVisibilityContext.Provider value={tab.id === currentTabId}>
                      <PatientChartGrid
                        widgets={widgetsByTab.get(tab.id) ?? emptyWidgets}
                        tabs={boardTabs}
                        editMode={editMode}
                        hideTitleBars={(currentBoard.showWidgetTitles ?? true) === false}
                        widgetSpacing={currentBoard.widgetSpacing}
                        fitToHeight={currentBoard.fitToHeight ?? true}
                      />
                    </TabVisibilityContext.Provider>
                  </div>
                ))
              ) : (
                <div className="flex h-full items-center justify-center p-8">
                  <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 py-16">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                      <LayoutGrid
                        size={24}
                        className="text-muted-foreground"
                      />
                    </div>
                    <h3 className="mt-4 text-sm font-medium text-foreground">
                      {t('patient_data.empty_title')}
                    </h3>
                    <p className="mt-1.5 max-w-xs text-center text-xs text-muted-foreground">
                      {t('patient_data.empty_description')}
                    </p>
                    <Button
                      size="sm"
                      className="mt-4 gap-1.5"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditMode(true)
                        setAddWidgetOpen(true)
                      }}
                    >
                      <Plus size={14} />
                      {t('dashboard.add_widget')}
                    </Button>
                  </div>
                </div>
              )}
            </Allotment.Pane>
            <Allotment.Pane minSize={250} preferredSize={320} visible={sidebarVisible}>
              <PatientDataSidebar />
            </Allotment.Pane>
          </Allotment>
        </div>

        <AddPatientWidgetDialog
          open={addWidgetOpen}
          onOpenChange={setAddWidgetOpen}
          tabId={currentTabId ?? ''}
          widgetSpacing={currentBoard.widgetSpacing}
          fitToHeight={currentBoard.fitToHeight ?? true}
        />

        <PatientDataSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          dashboardId={currentBoard.id}
        />
      </div>
    </PatientChartContext.Provider>
  )
}
