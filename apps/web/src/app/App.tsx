import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Routes, Route, Navigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { seedDemoDatabase } from '@/lib/demo-seed'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { StatusBar } from '@/components/layout/StatusBar'
import { WorkspaceGuard } from '@/app/WorkspaceGuard'
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
import { AppDataQualityPage } from '@/features/warehouse/AppDataQualityPage'
import { AppVersioningPage } from '@/features/versioning/AppVersioningPage'
import { WorkspacesPage } from '@/features/workspaces/WorkspacesPage'
import { WorkspaceHomePage } from '@/features/workspaces/WorkspaceHomePage'
import { WorkspaceSettingsPage } from '@/features/workspaces/WorkspaceSettingsPage'

export function App() {
  const { darkMode, language, projectsLoaded, loadProjects, activeProjectUid } = useAppStore()
  const { organizationsLoaded, loadOrganizations } = useOrganizationStore()
  const { workspacesLoaded, loadWorkspaces } = useWorkspaceStore()
  const { dataSourcesLoaded, loadDataSources, mountProjectSources } = useDataSourceStore()
  const { cohortsLoaded, loadCohorts } = useCohortStore()
  const { pipelinesLoaded, loadPipelines } = usePipelineStore()
  const { i18n } = useTranslation()

  useEffect(() => {
    loadOrganizations()
    loadWorkspaces()
    loadProjects()
    loadDataSources()
    loadCohorts()
    loadPipelines()
  }, [loadOrganizations, loadWorkspaces, loadProjects, loadDataSources, loadCohorts, loadPipelines])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  useEffect(() => {
    i18n.changeLanguage(language)
  }, [language, i18n])

  // Seed demo database on first launch, then reload stores
  useEffect(() => {
    if (projectsLoaded && dataSourcesLoaded) {
      seedDemoDatabase().then(() => {
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

  if (!organizationsLoaded || !workspacesLoaded || !projectsLoaded || !dataSourcesLoaded || !cohortsLoaded || !pipelinesLoaded) {
    return null
  }

  return (
    <SidebarProvider className="!min-h-0 h-screen">
      <AppSidebar />
      <SidebarInset className="flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-hidden">
          <Routes>
            {/* App-level routes */}
            <Route path="/" element={<HomePage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/profile" element={<ProfilePage />} />

            {/* Workspace-level routes */}
            <Route path="/workspaces/:wsUid" element={<WorkspaceGuard><Navigate to="home" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/home" element={<WorkspaceGuard><WorkspaceHomePage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects" element={<WorkspaceGuard><ProjectsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/wiki" element={<WorkspaceGuard><WikiPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/plugins" element={<WorkspaceGuard><PluginsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse" element={<WorkspaceGuard><Navigate to="databases" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/databases" element={<WorkspaceGuard><AppDatabasesPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/schemas" element={<WorkspaceGuard><SchemaPresetsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/schemas/:schemaId" element={<WorkspaceGuard><SchemaPresetsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/schema-presets" element={<WorkspaceGuard><Navigate to="../schemas" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/concept-mapping" element={<WorkspaceGuard><ConceptMappingPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/data-quality" element={<WorkspaceGuard><AppDataQualityPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/etl" element={<WorkspaceGuard><EtlPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/etl/:pipelineId" element={<WorkspaceGuard><EtlPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/versioning" element={<WorkspaceGuard><AppVersioningPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/settings" element={<WorkspaceGuard><WorkspaceSettingsPage /></WorkspaceGuard>} />

            {/* Project-level routes (nested under workspace) */}
            <Route path="/workspaces/:wsUid/projects/:uid" element={<WorkspaceGuard><Navigate to="summary" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/summary" element={<WorkspaceGuard><SummaryPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/pipeline" element={<WorkspaceGuard><PipelinePage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/ide" element={<WorkspaceGuard><IdePage /></WorkspaceGuard>} />

            {/* Project warehouse routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/databases" element={<WorkspaceGuard><DatabasesPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/concepts" element={<WorkspaceGuard><ConceptsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/data-quality" element={<WorkspaceGuard><DataQualityPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/cohorts" element={<WorkspaceGuard><WarehouseCohortsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/patient-data" element={<WorkspaceGuard><PatientDataPage /></WorkspaceGuard>} />

            {/* Project lab routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/lab/datasets" element={<WorkspaceGuard><DatasetsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/dashboards" element={<WorkspaceGuard><LabDashboardsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/dashboards/:dashboardId" element={<WorkspaceGuard><DashboardPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/reports" element={<WorkspaceGuard><ReportsPage /></WorkspaceGuard>} />

            {/* Project common routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/versioning" element={<WorkspaceGuard><VersioningPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/settings" element={<WorkspaceGuard><ProjectSettingsPage /></WorkspaceGuard>} />

            {/* Legacy redirects */}
            <Route path="/projects" element={<Navigate to="/workspaces" replace />} />
            <Route path="/projects/*" element={<Navigate to="/workspaces" replace />} />
            <Route path="/wiki" element={<Navigate to="/workspaces" replace />} />
            <Route path="/plugins" element={<Navigate to="/workspaces" replace />} />
            <Route path="/warehouse/*" element={<Navigate to="/workspaces" replace />} />
            <Route path="/versioning" element={<Navigate to="/workspaces" replace />} />

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <StatusBar />
      </SidebarInset>
    </SidebarProvider>
  )
}
