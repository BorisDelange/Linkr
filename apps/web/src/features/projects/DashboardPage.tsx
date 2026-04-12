import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router'
import { Plus, LayoutGrid, Pencil, Lock, ArrowLeft, Filter, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { DashboardTabBar } from './dashboard/DashboardTabBar'
import { WidgetGrid } from './dashboard/WidgetGrid'
import { AddWidgetDialog } from './dashboard/AddWidgetDialog'
import { DashboardFilterSidebar } from './dashboard/DashboardFilterSidebar'
import { DashboardSettingsDialog } from './dashboard/DashboardSettingsDialog'

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

  const {
    dashboards,
    tabs,
    widgets,
    activeTabId,
    loaded,
    loadProjectDashboards,
    setActiveDashboard,
  } = useDashboardStore()

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
  const currentTabId = activeTabId[currentDashboardId] ?? dashboardTabs[0]?.id
  const tabWidgets = widgets.filter((w) => w.tabId === currentTabId)

  // All widgets in this dashboard (across all tabs) — for filter sidebar dataset list
  const allDashboardWidgets = widgets.filter((w) => {
    const tabIds = new Set(dashboardTabs.map((t) => t.id))
    return tabIds.has(w.tabId)
  })

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
      <div className="flex items-center border-b px-3 shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          className="mr-1"
          onClick={() => navigate(`/workspaces/${wsUid}/projects/${projectUid}/lab/dashboards`)}
          title={t('dashboard.back_to_list')}
        >
          <ArrowLeft size={14} />
        </Button>

        <DashboardTabBar dashboardId={currentDashboardId} editMode={editMode} />

        <div className="ml-auto flex items-center gap-1 py-1">
          <Button
            variant={filterOpen ? 'default' : 'ghost'}
            size="xs"
            className="gap-1"
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Filter size={12} />
            {t('dashboard.toggle_filters')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="gap-1"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={12} />
            {t('common.settings')}
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
        </div>
      </div>

      {/* Main content + filter sidebar */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="flex-1 min-h-0 min-w-0">
          {tabWidgets.length > 0 ? (
            <WidgetGrid
              widgets={tabWidgets}
              editMode={editMode}
              hideTitleBars={dashboard.showWidgetTitles === false}
              dashboard={dashboard}
              projectUid={projectUid}
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
      />

      <DashboardSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        dashboard={dashboard}
      />
    </div>
  )
}
