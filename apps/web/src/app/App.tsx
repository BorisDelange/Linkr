import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Routes, Route, Navigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { seedDemoDatabase, seedDemoDashboard } from '@/lib/demo-seed'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { StatusBar } from '@/components/layout/StatusBar'
import { HomePage } from '@/features/home/HomePage'
import { ProjectsPage } from '@/features/projects/ProjectsPage'
import { SummaryPage } from '@/features/projects/SummaryPage'
import { PipelinePage } from '@/features/projects/PipelinePage'
import { DatabasesPage } from '@/features/projects/warehouse/DatabasesPage'
import { ConceptsPage } from '@/features/projects/warehouse/ConceptsPage'
import { DataQualityPage } from '@/features/projects/warehouse/DataQualityPage'
import { WarehouseCohortsPage } from '@/features/projects/warehouse/CohortsPage'
import { PatientDataPage } from '@/features/projects/warehouse/PatientDataPage'
import { DatasetsPage } from '@/features/projects/lab/DatasetsPage'
import { IdePage } from '@/features/projects/lab/IdePage'
import { LabDashboardsPage } from '@/features/projects/lab/LabDashboardsPage'
import { DashboardPage } from '@/features/projects/DashboardPage'
import { ReportsPage } from '@/features/projects/lab/ReportsPage'
import { VersioningPage } from '@/features/projects/VersioningPage'
import { ProjectSettingsPage } from '@/features/projects/ProjectSettingsPage'

import { SettingsPage } from '@/features/settings/SettingsPage'
import { PluginsPage } from '@/features/settings/PluginsPage'
import { ProfilePage } from '@/features/settings/ProfilePage'
import { CatalogPage } from '@/features/catalog/CatalogPage'
import { WikiPage } from '@/features/wiki/WikiPage'
import { AppDatabasesPage } from '@/features/warehouse/AppDatabasesPage'
import { SchemaPresetsPage } from '@/features/warehouse/SchemaPresetsPage'
import { ConceptMappingPage } from '@/features/warehouse/ConceptMappingPage'
import { EtlPage } from '@/features/warehouse/EtlPage'
import { AppVersioningPage } from '@/features/versioning/AppVersioningPage'

export function App() {
  const { darkMode, language, projectsLoaded, loadProjects, activeProjectUid } = useAppStore()
  const { dataSourcesLoaded, loadDataSources, mountProjectSources } = useDataSourceStore()
  const { cohortsLoaded, loadCohorts } = useCohortStore()
  const { pipelinesLoaded, loadPipelines } = usePipelineStore()
  const { i18n } = useTranslation()

  useEffect(() => {
    loadProjects()
    loadDataSources()
    loadCohorts()
    loadPipelines()
  }, [loadProjects, loadDataSources, loadCohorts, loadPipelines])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  useEffect(() => {
    i18n.changeLanguage(language)
  }, [language, i18n])

  // Seed demo database and dashboard on first launch, then reload stores
  useEffect(() => {
    if (projectsLoaded && dataSourcesLoaded) {
      Promise.all([seedDemoDatabase(), seedDemoDashboard()]).then(() => {
        loadProjects()
        loadDataSources()
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, dataSourcesLoaded])

  // Auto-mount data sources when entering a project
  useEffect(() => {
    if (activeProjectUid && dataSourcesLoaded) {
      mountProjectSources(activeProjectUid)
    }
  }, [activeProjectUid, dataSourcesLoaded, mountProjectSources])

  if (!projectsLoaded || !dataSourcesLoaded || !cohortsLoaded || !pipelinesLoaded) {
    return null
  }

  return (
    <SidebarProvider className="!min-h-0 h-screen">
      <AppSidebar />
      <SidebarInset className="flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/projects" element={<ProjectsPage />} />

            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/wiki" element={<WikiPage />} />
            <Route path="/warehouse" element={<Navigate to="/warehouse/databases" replace />} />
            <Route path="/warehouse/databases" element={<AppDatabasesPage />} />
            <Route path="/warehouse/schema-presets" element={<SchemaPresetsPage />} />
            <Route path="/warehouse/concept-mapping" element={<ConceptMappingPage />} />
            <Route path="/warehouse/etl" element={<EtlPage />} />
            <Route path="/versioning" element={<AppVersioningPage />} />

            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/profile" element={<ProfilePage />} />

            {/* Project-level routes */}
            <Route path="/projects/:uid" element={<Navigate to="summary" replace />} />
            <Route path="/projects/:uid/summary" element={<SummaryPage />} />
            <Route path="/projects/:uid/pipeline" element={<PipelinePage />} />
            <Route path="/projects/:uid/ide" element={<IdePage />} />

            {/* Warehouse routes */}
            <Route path="/projects/:uid/warehouse/databases" element={<DatabasesPage />} />
            <Route path="/projects/:uid/warehouse/concepts" element={<ConceptsPage />} />
            <Route path="/projects/:uid/warehouse/data-quality" element={<DataQualityPage />} />
            <Route path="/projects/:uid/warehouse/cohorts" element={<WarehouseCohortsPage />} />
            <Route path="/projects/:uid/warehouse/patient-data" element={<PatientDataPage />} />

            {/* Lab routes */}
            <Route path="/projects/:uid/lab/datasets" element={<DatasetsPage />} />
            <Route path="/projects/:uid/lab/dashboards" element={<LabDashboardsPage />} />
            <Route path="/projects/:uid/lab/dashboards/:dashboardId" element={<DashboardPage />} />
            <Route path="/projects/:uid/lab/reports" element={<ReportsPage />} />

            {/* Common routes */}
            <Route path="/projects/:uid/versioning" element={<VersioningPage />} />
            <Route path="/projects/:uid/settings" element={<ProjectSettingsPage />} />

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <StatusBar />
      </SidebarInset>
    </SidebarProvider>
  )
}
