import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Plus, Pencil, Lock, Users, LayoutGrid, Settings2, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDataSourceStore } from '@/stores/data-source-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { PatientChartContext } from './patient-data/PatientChartContext'
import { PatientChartTabBar } from './patient-data/PatientChartTabBar'
import { PatientChartGrid } from './patient-data/PatientChartGrid'
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

  const { tabs, widgets, activeTabId, showWidgetTitles, ensureDefaults } = usePatientChartStore()

  // Ensure default tabs+widgets exist for this project on first visit
  useEffect(() => {
    if (projectUid) ensureDefaults(projectUid)
  }, [projectUid, ensureDefaults])

  const projectTabs = tabs
    .filter((tab) => tab.projectUid === projectUid)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  const currentTabId = activeTabId[projectUid] ?? projectTabs[0]?.id
  const tabWidgets = widgets.filter((w) => w.tabId === currentTabId)

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

          <div className="ml-auto flex items-center gap-1 py-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setSettingsOpen(true)}
              title={t('patient_data.settings_title')}
            >
              <Settings2 size={13} />
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
            <Button
              variant={sidebarVisible ? 'ghost' : 'secondary'}
              size="icon-xs"
              onClick={() => setSidebarVisible(!sidebarVisible)}
              title={t('patient_data.toggle_sidebar')}
            >
              <PanelRight size={13} />
            </Button>
          </div>
        </div>

        {/* Main content: dashboard + sidebar */}
        <div className="flex-1 overflow-hidden">
          <Allotment>
            <Allotment.Pane minSize={500}>
              {tabWidgets.length > 0 ? (
                <ScrollArea className="h-full">
                  <PatientChartGrid
                    widgets={tabWidgets}
                    editMode={editMode}
                    hideTitleBars={(showWidgetTitles[projectUid] ?? true) === false}
                  />
                </ScrollArea>
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
