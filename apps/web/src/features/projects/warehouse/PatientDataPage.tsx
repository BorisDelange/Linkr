import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Allotment, LayoutPriority, type AllotmentHandle } from 'allotment'
import 'allotment/dist/style.css'
import { Plus, Pencil, Lock, Users, LayoutGrid, Settings2, PanelRight, ClipboardList } from 'lucide-react'
import { useStickyFlag, useStickyState } from '@/hooks/use-sticky-state'
import { paneSizes, paneSizesAfterReset } from './patient-data/pane-layout'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip'
import { useProjectSource } from '@/stores/data-source-store'
import { isProjectBoard, usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientChartContext } from './patient-data/PatientChartContext'
import { PatientChartTabBar } from './patient-data/PatientChartTabBar'
import { PatientChartGrid } from './patient-data/PatientChartGrid'
import { TabVisibilityContext } from './patient-data/TabVisibilityContext'
import { PatientDataSidebar } from './patient-data/PatientDataSidebar'
import { AddPatientWidgetDialog } from './patient-data/AddPatientWidgetDialog'
import { PatientDataSettingsDialog } from './patient-data/PatientDataSettingsDialog'
import { CollectionSidebar } from './patient-data/collection/CollectionSidebar'
import { CollectionStatusDot } from './patient-data/collection/CollectionStatusDot'
import { usePatientCollection } from './patient-data/collection/use-patient-collection'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'

/** Default width of each side panel. The patient sidebar and the collection panel
 *  share it so opening the second doesn't make the pair look mismatched. */
const SIDE_PANE_WIDTH = 320
const SIDE_PANE_MIN = 250
const SIDE_PANE_MAX = 640
/** Dashboard + patient sidebar + collection panel. */
const PANE_COUNT = 3

/** A stored width is only ever trusted inside the range a panel may occupy. */
const clampPaneWidth = (w: number) =>
  Number.isFinite(w) ? Math.min(Math.max(w, SIDE_PANE_MIN), SIDE_PANE_MAX) : SIDE_PANE_WIDTH

export function PatientDataPage() {
  const { t } = useTranslation()
  const { wsUid, projectUid: resolvedUid, raw } = useResolvedParams()
  const navigate = useNavigate()
  const projectUid = resolvedUid ?? ''
  const canWrite = useMyProjectRole(projectUid).can('patient-data:write')
  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Persisted, not component state: leaving the page and coming back should show
  // the workspace as it was left, the same way the board itself is remembered.
  const [collectionOpen, setCollectionOpen] = useStickyFlag('linkr.patient-collection-open', false)
  // Each side panel remembers its OWN width, rather than the whole split being
  // stored as one positional array. Allotment's `defaultSizes` is indexed over every
  // pane (hidden ones included) and is thrown away wholesale on a length mismatch, so
  // an array saved with one set of panes visible gets replayed onto a different set —
  // which is what handed the collection panel's width to the patient sidebar.
  //
  // Clamped on read as well as on write: a width persisted by an earlier build (or by
  // a wider window) must not be able to restore a panel wider than it may ever be.
  const [rawSidebarWidth, setSidebarWidth] = useStickyState('linkr.patient-sidebar-width', SIDE_PANE_WIDTH)
  const [rawCollectionWidth, setCollectionWidth] = useStickyState('linkr.patient-collection-width', SIDE_PANE_WIDTH)
  const sidebarWidth = clampPaneWidth(rawSidebarWidth)
  const collectionWidth = clampPaneWidth(rawCollectionWidth)
  const allotmentRef = useRef<AllotmentHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Narrow selectors: a bare usePatientChartStore() would re-render the whole page
  // on every selection change.
  const selectedPatientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const selectedVisitId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const selectedVisitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)
  const [sidebarVisible, setSidebarVisible] = useStickyFlag('linkr.patient-sidebar-open', true)

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

  // Allotment's `resize` walks the array we hand it and indexes its own view list by
  // position, with no bounds check — so calling it before every pane has been
  // constructed throws on `undefined.minimumSize`. On the first render the panes are
  // not mounted yet, hence the guard: only resize once the DOM shows all three.
  const applyPaneSizes = useCallback((sizesFor: (total: number) => number[]) => {
    const el = containerRef.current
    if (!el) return
    const total = el.clientWidth
    if (!total) return
    if (el.querySelectorAll('[data-testid="sash"]').length < PANE_COUNT - 1) return
    allotmentRef.current?.resize(sizesFor(total))
  }, [])

  // Reopening a panel restores the width it was last dragged to. This is done here
  // rather than through `preferredSize` because that prop doubles as the
  // double-click reset target — see the pane below. The dashboard pane absorbs the
  // difference, so its size is whatever is left.
  useEffect(() => {
    applyPaneSizes((total) => paneSizes({
      total, sidebarVisible, collectionOpen, sidebarWidth, collectionWidth,
    }))
    // Only on a visibility change: re-running when the widths themselves change would
    // fight the drag that is producing them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarVisible, collectionOpen])

  // Double-clicking a border resets THAT border's panel to its default width, and
  // leaves the other panel alone.
  //
  // Allotment's own handler resets the pane on the LEFT of the sash first, falling
  // back to the one on its right — so double-clicking the collection panel's border
  // resized the patient sidebar instead, and the collection panel never moved. We
  // handle the event during capture, before Allotment sees it, and stop it there.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onDoubleClick = (e: MouseEvent) => {
      const sash = (e.target as HTMLElement | null)?.closest('[data-testid="sash"]')
      if (!sash) return
      // One sash per pane boundary, in pane order, and a hidden pane keeps its sash
      // (Allotment only disables it) — so sash N is always the left border of pane
      // N+1, whatever is currently visible. Pane 1 is the sidebar, pane 2 the
      // collection panel.
      const sashes = [...el.querySelectorAll('[data-testid="sash"]')]
      const index = sashes.indexOf(sash)
      const target = index === 0 ? 'sidebar' : index === 1 ? 'collection' : null
      if (!target) return
      if (target === 'sidebar' ? !sidebarVisible : !collectionOpen) return
      e.preventDefault()
      e.stopPropagation()
      applyPaneSizes((total) => paneSizesAfterReset(
        { total, sidebarVisible, collectionOpen, sidebarWidth, collectionWidth },
        target,
        SIDE_PANE_WIDTH,
      ))
      if (target === 'sidebar') setSidebarWidth(SIDE_PANE_WIDTH)
      else setCollectionWidth(SIDE_PANE_WIDTH)
    }
    el.addEventListener('dblclick', onDoubleClick, true)
    return () => el.removeEventListener('dblclick', onDoubleClick, true)
  }, [
    sidebarVisible, collectionOpen, sidebarWidth, collectionWidth,
    setSidebarWidth, setCollectionWidth, applyPaneSizes,
  ])

  const projectBoards = dashboards
    .filter((d) => isProjectBoard(d, projectUid))
    .sort((a, b) => a.displayOrder - b.displayOrder)
  // The URL carries a short id prefix (see short-id.ts), so resolve it against the
  // project's boards rather than matching the raw param.
  const currentBoard = resolveByIdPrefix(projectBoards, raw.boardId, (d) => d.id)

  // Each board reads the database it was configured with, so two boards of the
  // same project can sit on different databases.
  const mappedSource = useProjectSource(projectUid, currentBoard?.dataSourceId)
  const dataSourceId = mappedSource?.id
  const schemaMapping = mappedSource?.schemaMapping

  useEffect(() => {
    if (currentBoard) setActiveDashboard(projectUid, currentBoard.id)
  }, [projectUid, currentBoard, setActiveDashboard])

  // Read here as well as in the panel, so the toolbar dot reports this patient's
  // progress whether or not the panel is open.
  const { fields: collectionFields } = usePatientCollection(currentBoard?.collection, {
    personId: selectedPatientId,
    visitId: selectedVisitId,
    visitDetailId: selectedVisitDetailId,
  }, projectUid)

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
      value={{ projectUid, boardId: currentBoard.id, dataSourceId, schemaMapping }}
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
                variant={collectionOpen ? 'secondary' : 'ghost'}
                size="xs"
                className="gap-1"
                onClick={() => setCollectionOpen((v) => !v)}
              >
                <ClipboardList size={13} />
                {t('patient_data.collection')}
                <CollectionStatusDot fields={collectionFields} />
              </Button>
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
        <div ref={containerRef} className="flex-1 overflow-hidden">
          {/* proportionalLayout={false}: the side panels keep the width they were
              given instead of growing with the window. Which pane absorbs a change is
              then decided by the per-pane `priority` below.

              Deliberately NOT keyed on the visible set: remounting threw away
              Allotment's sash state, which broke double-clicking a border. Reopening a
              panel restores its remembered width through the effect above instead. */}
          <Allotment
            ref={allotmentRef}
            proportionalLayout={false}
            onDragEnd={(sizes) => {
              // Positional over ALL panes, hidden ones reported as 0 — so only trust
              // an entry whose pane is actually on screen.
              const [, sidebar, collection] = sizes
              if (sidebarVisible && sidebar > 0) setSidebarWidth(sidebar)
              if (collectionOpen && collection > 0) setCollectionWidth(collection)
            }}
          >
            {/* Every width change — the window resizing, a side panel opening or
                closing — is absorbed HERE. `distributeEmptySpace` hands slack to
                panes in priority order (High, then Normal, then Low), so leaving all
                three Normal let the order fall out of the internal pane list: opening
                the collection panel took its width from the patient sidebar, which
                grew to swallow it instead. */}
            <Allotment.Pane minSize={500} priority={LayoutPriority.High}>
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
            {/* Low priority: a side panel keeps the width it was given, and never
                takes the slack from another one opening or closing.

                `preferredSize` is the CONSTANT default, never the remembered width:
                Allotment resets a sash's panes to `preferredSize` on double-click, so
                feeding it the live width made "reset" a no-op — it restored the width
                you had just dragged to. The remembered width is applied imperatively
                below instead, which leaves double-click meaning "back to default". */}
            <Allotment.Pane
              minSize={SIDE_PANE_MIN}
              preferredSize={SIDE_PANE_WIDTH}
              maxSize={SIDE_PANE_MAX}
              priority={LayoutPriority.Low}
              visible={sidebarVisible}
            >
              <PatientDataSidebar />
            </Allotment.Pane>
            {/* Docked, not overlaid: the collector reads the chart and fills this at
                the same time, so dimming the page would hide the source. */}
            <Allotment.Pane
              minSize={SIDE_PANE_MIN}
              preferredSize={SIDE_PANE_WIDTH}
              maxSize={SIDE_PANE_MAX}
              priority={LayoutPriority.Low}
              visible={collectionOpen}
            >
              <CollectionSidebar
                onClose={() => setCollectionOpen(false)}
                projectUid={projectUid}
                boardId={currentBoard.id}
                config={currentBoard.collection}
                personId={selectedPatientId}
                visitId={selectedVisitId}
                visitDetailId={selectedVisitDetailId}
                canWrite={canWrite}
              />
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
