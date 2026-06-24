import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router'
import { Plus, LayoutGrid, Layers, Pencil, Lock, Filter, Settings2, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { DashboardTabBar } from './dashboard/DashboardTabBar'
import { WidgetGrid } from './dashboard/WidgetGrid'
import { AddWidgetDialog } from './dashboard/AddWidgetDialog'
import { DashboardFilterSidebar } from './dashboard/DashboardFilterSidebar'
import { DashboardSettingsDialog } from './dashboard/DashboardSettingsDialog'
import { ExportDashboardDialog } from './dashboard/ExportDashboardDialog'
import { isWidgetPluginStale } from './dashboard/plugin-drift'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export function DashboardPage() {
  const { t } = useTranslation()
  const { wsUid, uid, dashboardId } = useParams()
  const navigate = useNavigate()
  const projectUid = uid ?? ''
  const currentDashboardId = dashboardId ?? ''

  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPreselectId, setExportPreselectId] = useState<string | null>(null)

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
  } = useDashboardStore()

  const activeFilterCount = Object.keys(activeFilters).length

  const { loadProjectDatasets } = useDatasetStore()

  useEffect(() => {
    loadProjectDashboards(projectUid)
    loadProjectDatasets(projectUid)
  }, [projectUid, loadProjectDashboards, loadProjectDatasets])

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

  // All widgets in this dashboard (across all tabs) — for filter sidebar dataset list
  const allDashboardWidgets = widgets.filter((w) => {
    const tabIds = new Set(dashboardTabs.map((t) => t.id))
    return tabIds.has(w.tabId)
  })

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
            onClick={() => navigate(`/workspaces/${wsUid}/projects/${projectUid}/lab/dashboards`)}
          >
            {t('dashboard.back_to_list')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab bar + actions */}
      <div className="border-b shrink-0">
      <div className="flex items-center px-3">
        <DashboardTabBar dashboardId={currentDashboardId} editMode={editMode} />

        <div className="ml-auto flex shrink-0 items-center gap-1 py-1 pl-4">
          <Button
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
          </Button>
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
          {activeTabIsContainer ? (
            <div className="flex h-full min-h-[400px] items-center justify-center p-8">
              <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 py-16">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                  <Layers size={24} className="text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-sm font-medium text-foreground">
                  {t('dashboard.container_tab_title')}
                </h3>
                <p className="mt-1.5 max-w-xs text-center text-xs text-muted-foreground">
                  {t('dashboard.container_tab_description')}
                </p>
              </div>
            </div>
          ) : tabWidgets.length > 0 ? (
            <WidgetGrid
              widgets={tabWidgets}
              editMode={editMode}
              hideTitleBars={dashboard.showWidgetTitles === false}
              dashboard={dashboard}
              projectUid={projectUid}
              onRequestExport={(widgetId) => { setExportPreselectId(widgetId); setExportOpen(true) }}
            />
          ) : (
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
  )
}
