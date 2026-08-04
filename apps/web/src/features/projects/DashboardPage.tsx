import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { GatedButton } from '@/components/ui/gated-button'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { Plus, LayoutGrid, Layers, Pencil, Lock, Filter, Settings2, Download, Maximize, Minimize } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/stores/dashboard-store'
import { PortalContainerProvider } from '@/lib/portal-container'
import { useDatasetStore } from '@/stores/dataset-store'
import { DashboardTabBar } from './dashboard/DashboardTabBar'
import { WidgetGrid } from './dashboard/WidgetGrid'
import { AddWidgetDialog } from './dashboard/AddWidgetDialog'
import { DashboardFilterSidebar } from './dashboard/DashboardFilterSidebar'
import { DashboardSettingsDialog } from './dashboard/DashboardSettingsDialog'
import { ExportDashboardDialog } from './dashboard/ExportDashboardDialog'
import { isWidgetPluginStale } from './dashboard/plugin-drift'
import { isServerMode } from '@/lib/api-client'
import { prewarmPool } from '@/lib/api/execution'
import { getPlugin } from '@/lib/plugins/registry'
import { componentSupportsServer } from '@/lib/plugins/component-registry'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export function DashboardPage() {
  const { t } = useTranslation()
  const { wsUid, projectUid: resolvedProjectUid, raw } = useResolvedParams()
  const navigate = useNavigate()
  const projectUid = resolvedProjectUid ?? ''
  const projectRole = useMyProjectRole(projectUid)
  const canWrite = projectRole.can('dashboards:write')
  const canExecute = projectRole.can('dashboards:execute')

  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPreselectId, setExportPreselectId] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      rootRef.current?.requestFullscreen().catch(() => {})
    }
  }

  // Track fullscreen changes (button click, Esc key, or browser chrome) to keep the icon in sync,
  // and capture the fullscreen element so Radix portals (menus, dialogs, tooltips) render INSIDE
  // it — otherwise they'd portal to document.body, outside the fullscreen subtree, and be invisible.
  const [fullscreenEl, setFullscreenEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement != null)
      setFullscreenEl(document.fullscreenElement as HTMLElement | null)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const {
    dashboards,
    tabs,
    widgets,
    activeTabId,
    activeFilters,
    loaded,
    loadProjectDashboards,
    setActiveDashboard,
    acceptAllPluginVersions,
    enterTab,
  } = useDashboardStore()

  const activeFilterCount = Object.keys(activeFilters).length

  // Resolve the short :dashboardId prefix to the full dashboard id from the loaded dashboards.
  const currentDashboardId = resolveByIdPrefix(dashboards, raw.dashboardId, (d) => d.id)?.id
    ?? raw.dashboardId ?? ''

  const { loadProjectDatasets } = useDatasetStore()

  useEffect(() => {
    loadProjectDashboards(projectUid)
    loadProjectDatasets(projectUid)
  }, [projectUid, loadProjectDashboards, loadProjectDatasets])

  // Server mode: pre-start the warm pools sized to the CURRENT tab's widgets so a
  // page of N widgets gets N warm processes and they run warm+parallel (not "2 warm
  // + the rest cold-starting"). Three buckets:
  //  - code widgets (inline / script plugin) → managed env, gated on execute
  //  - component widgets that compute server-side (plot-builder, table1…) → app
  //    interpreter via /execute/render (viewer-visible, no execute perm needed)
  useEffect(() => {
    // activeTabId is a per-dashboard map (dashboardId → tabId); resolve the tab
    // for the dashboard on screen before matching widgets to it.
    const currentTab = currentDashboardId ? activeTabId[currentDashboardId] : undefined
    if (!projectUid || !isServerMode() || !currentTab) return
    let codePy = 0
    let codeR = 0
    let renderPy = 0
    for (const w of widgets) {
      if (w.tabId !== currentTab) continue
      const src = w.source
      if (src.type === 'inline') {
        if (!canExecute) continue
        if (src.language === 'r') codeR++; else codePy++
      } else if (src.type === 'plugin') {
        const plugin = getPlugin(src.pluginId)
        const isComponent = !!(plugin?.componentId && plugin.manifest.runtime.includes('component'))
        if (isComponent) {
          // Component renders run server-side (python, app interpreter) via /render.
          if (plugin?.componentId && componentSupportsServer(plugin.componentId)) renderPy++
          continue
        }
        if (!canExecute) continue
        const lang = src.language ?? (plugin?.templates?.python ? 'python' : 'r')
        if (lang === 'r') codeR++; else codePy++
      }
    }
    if (codePy > 0) prewarmPool('python', projectUid, { count: codePy })
    if (codeR > 0) prewarmPool('r', projectUid, { count: codeR })
    if (renderPy > 0) prewarmPool('python', projectUid, { count: renderPy, appEnv: true })
  }, [projectUid, canExecute, activeTabId, widgets, currentDashboardId])

  useEffect(() => {
    if (currentDashboardId) {
      setActiveDashboard(currentDashboardId)
    }
  }, [currentDashboardId, setActiveDashboard])

  const dashboard = dashboards.find((d) => d.id === currentDashboardId)

  const dashboardTabs = tabs
    .filter((tab) => tab.dashboardId === currentDashboardId)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  // The tab bar tracks a single active tab (any nesting level). It may be a container — a tab
  // that has sub-tabs and therefore no widgets of its own; in that case we show a hint to pick
  // a sub-tab rather than rendering an (empty) grid. Default to the first root tab as-is.
  const rootTabs = dashboardTabs.filter((tab) => !tab.parentTabId)
  const currentTabId = activeTabId[currentDashboardId] ?? rootTabs[0]?.id
  const activeTabIsContainer = currentTabId
    ? dashboardTabs.some((tab) => tab.parentTabId === currentTabId)
    : false
  const tabWidgets = widgets.filter((w) => w.tabId === currentTabId)

  // Keep-alive for visited leaf tabs: once a tab with widgets is shown, keep its grid mounted
  // (hidden via CSS when inactive) so returning to it doesn't remount — no figure redraw, and
  // widget results stay live in the DOM. Unvisited tabs are never mounted, so we don't pay the
  // cost of tabs the user never opens.
  //
  // "Reload widgets on tab switch" turns keep-alive OFF: only the current tab is mounted, so
  // leaving a tab frees its DOM and returning remounts + recomputes it. The lever for very large
  // dashboards / low-end machines that shouldn't accumulate mounted tabs.
  const keepAlive = dashboard?.reloadWidgetsOnTabSwitch !== true
  const [visitedTabIds, setVisitedTabIds] = useState<Set<string>>(new Set())
  const isMountableLeaf = !!currentTabId && !activeTabIsContainer && tabWidgets.length > 0
  // Drop the visited set when the dashboard changes — its tab ids no longer apply.
  useEffect(() => {
    setVisitedTabIds(new Set())
  }, [currentDashboardId])
  useEffect(() => {
    if (keepAlive && isMountableLeaf && currentTabId && !visitedTabIds.has(currentTabId)) {
      setVisitedTabIds((prev) => new Set(prev).add(currentTabId))
    }
  }, [keepAlive, isMountableLeaf, currentTabId, visitedTabIds])
  // With keep-alive: every visited leaf tab (+ the current one on its first render, before the
  // effect records it). Without: only the current leaf tab, so switching away unmounts it.
  const mountedTabs = dashboardTabs.filter((tab) =>
    keepAlive
      ? visitedTabIds.has(tab.id) || (isMountableLeaf && tab.id === currentTabId)
      : isMountableLeaf && tab.id === currentTabId,
  )

  // All widgets in this dashboard (across all tabs) — for filter sidebar dataset list
  const allDashboardWidgets = widgets.filter((w) => {
    const tabIds = new Set(dashboardTabs.map((t) => t.id))
    return tabIds.has(w.tabId)
  })

  // Widgets grouped by tab id, recomputed only when `widgets` actually changes. Each tab's slice
  // keeps a STABLE reference across tab switches, so a memoized WidgetGrid whose props are otherwise
  // unchanged bails out of re-rendering — switching tabs then costs one class flip, not a full
  // reconcile of every kept-alive grid's charts (the ~1s freeze on tab click).
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

  // Stable so it doesn't defeat WidgetGrid's memoization on every DashboardPage render.
  const handleRequestExport = useCallback((widgetId: string) => {
    setExportPreselectId(widgetId)
    setExportOpen(true)
  }, [])

  // Count widgets (across every tab) whose plugin changed since they were created/edited.
  const staleWidgetCount = useMemo(
    () => allDashboardWidgets.filter(isWidgetPluginStale).length,
    [allDashboardWidgets],
  )

  if (!loaded) return null

  if (!dashboard) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Dashboard not found</p>
          <Button
            variant="link"
            size="sm"
            className="mt-2"
            onClick={() => navigate(paths.dashboards(wsUid ?? '', projectUid))}
          >
            {t('dashboard.back_to_list')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <PortalContainerProvider value={fullscreenEl}>
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden bg-background">
      {/* Tab bar + actions */}
      <div className="border-b shrink-0">
      <div className="flex items-center px-3">
        <DashboardTabBar dashboardId={currentDashboardId} editMode={editMode} />

        <div className="ml-auto flex shrink-0 items-center gap-1 py-1 pl-4">
          <GatedButton
            allowed={canWrite}
            notAllowedReason={t('common.insufficient_permissions')}
            variant={editMode ? 'default' : 'ghost'}
            size="xs"
            className="gap-1"
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
          </GatedButton>
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
          <Button
            variant="ghost"
            size="xs"
            className="gap-1"
            disabled={!canWrite}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={12} />
            {t('common.settings')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="gap-1"
            onClick={() => { setExportPreselectId(null); setExportOpen(true) }}
            disabled={tabWidgets.length === 0}
          >
            <Download size={12} />
            {t('dashboard.export', 'Export')}
          </Button>
          <Button
            variant={filterOpen ? 'default' : 'ghost'}
            size="xs"
            className="gap-1"
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Filter size={12} />
            {activeFilterCount > 0
              ? t('dashboard.toggle_filters_count', { count: activeFilterCount })
              : t('dashboard.toggle_filters')}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={toggleFullscreen}
            title={isFullscreen ? t('dashboard.exit_fullscreen') : t('dashboard.enter_fullscreen')}
          >
            {isFullscreen ? <Minimize size={12} /> : <Maximize size={12} />}
          </Button>
        </div>
      </div>
      </div>

      {/* Plugin drift banner — a plugin used here changed since some widgets were built. */}
      {staleWidgetCount > 0 && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{t('dashboard.plugin_drift_banner', { count: staleWidgetCount })}</span>
          <Button
            size="xs"
            variant="outline"
            className="gap-1 border-amber-500/40"
            disabled={!canWrite}
            onClick={() => acceptAllPluginVersions(currentDashboardId)}
          >
            <RefreshCw size={12} />
            {t('dashboard.plugin_drift_accept_all')}
          </Button>
        </div>
      )}

      {/* Main content + filter sidebar */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="flex-1 min-h-0 min-w-0">
          {/* Every visited leaf tab's grid stays mounted. This renders regardless of the active
              tab: switching to a container tab or an empty leaf must NOT unmount the kept-alive
              grids, or their widgets (e.g. KPI plugins) would recompute on return. React keys by
              tab id so each grid keeps its subtree across switches — persistence lives at the
              dashboard level.

              Inactive tabs are parked off-screen with `invisible` (NOT `display:none`): a hidden
              grid keeps its laid-out box and full width, so a chart's ResizeObserver (Recharts
              ResponsiveContainer) never sees a 0-width → real-width transition and doesn't redraw
              its whole SVG when the tab is shown again — that redraw was the visible lag when
              switching between plot-builder widgets. */}
          {mountedTabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === currentTabId ? 'contents' : 'invisible absolute top-0 left-0 w-full'}
              aria-hidden={tab.id !== currentTabId}
            >
              <WidgetGrid
                widgets={widgetsByTab.get(tab.id) ?? emptyWidgets}
                editMode={editMode}
                hideTitleBars={dashboard.showWidgetTitles === false}
                dashboard={dashboard}
                projectUid={projectUid}
                onRequestExport={handleRequestExport}
              />
            </div>
          ))}

          {activeTabIsContainer ? (
            <div className="flex h-full min-h-[400px] items-center justify-center p-8">
              <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 py-16">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                  <Layers size={24} className="text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-sm font-medium text-foreground">
                  {t('dashboard.container_tab_title')}
                </h3>
                <Button
                  size="sm"
                  className="mt-4 gap-1.5"
                  onClick={() => currentTabId && enterTab(currentDashboardId, currentTabId)}
                >
                  <Layers size={14} />
                  {t('dashboard.container_tab_open')}
                </Button>
              </div>
            </div>
          ) : tabWidgets.length === 0 ? (
            <div className="flex h-full min-h-[400px] items-center justify-center p-8">
              <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 py-16">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                  <LayoutGrid size={24} className="text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-sm font-medium text-foreground">
                  {t('dashboard.empty_title')}
                </h3>
                <p className="mt-1.5 max-w-xs text-center text-xs text-muted-foreground">
                  {t('dashboard.empty_description')}
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
          ) : null}
        </ScrollArea>

        {filterOpen && (
          <DashboardFilterSidebar
            dashboard={dashboard}
            widgets={allDashboardWidgets}
            tabs={dashboardTabs}
            editMode={editMode}
            onClose={() => setFilterOpen(false)}
          />
        )}
      </div>

      <AddWidgetDialog
        open={addWidgetOpen}
        onOpenChange={setAddWidgetOpen}
        tabId={currentTabId ?? ''}
        projectUid={projectUid}
        defaultDatasetFileId={dashboard.defaultDatasetFileId}
      />

      <DashboardSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        dashboard={dashboard}
        projectUid={projectUid}
        currentTabId={currentTabId}
      />

      <ExportDashboardDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        dashboard={dashboard}
        tabs={dashboardTabs}
        allWidgets={allDashboardWidgets}
        currentTabId={currentTabId}
        preselectWidgetId={exportPreselectId}
      />
    </div>
    </PortalContainerProvider>
  )
}
