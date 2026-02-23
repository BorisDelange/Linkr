import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Plus, Pencil, Lock, Users, LayoutGrid, Settings2, PanelRight, AlertTriangle } from 'lucide-react'
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
import { PatientChartGrid, GRID_ROWS } from './patient-data/PatientChartGrid'
import { PatientDataSidebar } from './patient-data/PatientDataSidebar'
import { AddPatientWidgetDialog } from './patient-data/AddPatientWidgetDialog'
import { PatientDataSettingsDialog } from './patient-data/PatientDataSettingsDialog'

export function PatientDataPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const projectUid = uid ?? ''
  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)

  const { getActiveSource } = useDataSourceStore()
  const mappedSource = projectUid ? getActiveSource(projectUid) : undefined
  const dataSourceId = mappedSource?.id
  const schemaMapping = mappedSource?.schemaMapping

  const { tabs, widgets, activeTabId, showWidgetTitles, allowWidgetScroll, ensureDefaults } = usePatientChartStore()

  // Ensure default tabs+widgets exist for this project on first visit
  useEffect(() => {
    if (projectUid) ensureDefaults(projectUid)
  }, [projectUid, ensureDefaults])

  const projectTabs = tabs
    .filter((tab) => tab.projectUid === projectUid)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  const currentTabId = activeTabId[projectUid] ?? projectTabs[0]?.id
  const tabWidgets = widgets.filter((w) => w.tabId === currentTabId)

  const isScrollable = allowWidgetScroll[projectUid] ?? false
  // Detect widgets that overflow beyond the visible grid in bounded mode.
  const hasOverflow = useMemo(() => {
    if (isScrollable) return false
    return tabWidgets.some((w) => w.layout.y + w.layout.h > GRID_ROWS)
  }, [tabWidgets, isScrollable])

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
          <PatientChartTabBar projectUid={projectUid} editMode={editMode} />

          <TooltipProvider delayDuration={300}>
            <div className="ml-auto flex items-center gap-1 py-1">
              {hasOverflow && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1 text-amber-500 hover:text-amber-600"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <AlertTriangle size={13} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('patient_data.widgets_overflow_warning')}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings2 size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('patient_data.settings_title')}
                </TooltipContent>
              </Tooltip>
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
                <PatientChartGrid
                  widgets={tabWidgets}
                  editMode={editMode}
                  hideTitleBars={(showWidgetTitles[projectUid] ?? true) === false}
                  scrollable={allowWidgetScroll[projectUid] ?? false}
                />
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
        />

        <PatientDataSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          projectUid={projectUid}
        />
      </div>
    </PatientChartContext.Provider>
  )
}
