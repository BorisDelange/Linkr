import { useEffect, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Routes, Route, Navigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useVisitStore } from '@/stores/visit-store'
import { seedDatabases } from '@/lib/seed-loader'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { StatusBar } from '@/components/layout/StatusBar'
import { WorkspaceGuard } from '@/app/WorkspaceGuard'
import { ProjectGuard } from '@/app/ProjectGuard'
import { VersionCheckDialog } from '@/components/layout/VersionCheckDialog'
// Pages are lazy-loaded so each route's heavy libs (vis-network, leaflet, xterm,
// xyflow, xlsx, recharts, katex, isomorphic-git…) ship in a per-route chunk and
// are fetched only when that page is opened — not in the initial bundle.
const HomePage = lazy(() => import('@/features/home/HomePage').then(m => ({ default: m.HomePage })))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage').then(m => ({ default: m.ProjectsPage })))
const SummaryPage = lazy(() => import('@/features/projects/SummaryPage').then(m => ({ default: m.SummaryPage })))
const PipelinePage = lazy(() => import('@/features/projects/PipelinePage').then(m => ({ default: m.PipelinePage })))
const DatabasesPage = lazy(() => import('@/features/projects/warehouse/DatabasesPage').then(m => ({ default: m.DatabasesPage })))
const ConceptsPage = lazy(() => import('@/features/projects/warehouse/ConceptsPage').then(m => ({ default: m.ConceptsPage })))
const CohortListPage = lazy(() => import('@/features/projects/warehouse/cohorts/CohortListPage').then(m => ({ default: m.CohortListPage })))
const CohortBuilderPage = lazy(() => import('@/features/projects/warehouse/cohorts/CohortBuilderPage').then(m => ({ default: m.CohortBuilderPage })))
const PatientDataPage = lazy(() => import('@/features/projects/warehouse/PatientDataPage').then(m => ({ default: m.PatientDataPage })))
const DatasetsPage = lazy(() => import('@/features/projects/lab/DatasetsPage').then(m => ({ default: m.DatasetsPage })))
const IdePage = lazy(() => import('@/features/projects/lab/IdePage').then(m => ({ default: m.IdePage })))
const LabDashboardsPage = lazy(() => import('@/features/projects/lab/LabDashboardsPage').then(m => ({ default: m.LabDashboardsPage })))
const DashboardPage = lazy(() => import('@/features/projects/DashboardPage').then(m => ({ default: m.DashboardPage })))
const ReportsPage = lazy(() => import('@/features/projects/lab/ReportsPage').then(m => ({ default: m.ReportsPage })))
const VersioningPage = lazy(() => import('@/features/projects/VersioningPage').then(m => ({ default: m.VersioningPage })))
const ProjectSettingsPage = lazy(() => import('@/features/projects/ProjectSettingsPage').then(m => ({ default: m.ProjectSettingsPage })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
const PluginsPage = lazy(() => import('@/features/settings/PluginsPage').then(m => ({ default: m.PluginsPage })))
const ProfilePage = lazy(() => import('@/features/settings/ProfilePage').then(m => ({ default: m.ProfilePage })))
const CatalogPage = lazy(() => import('@/features/catalog/CatalogPage').then(m => ({ default: m.CatalogPage })))
const WikiPage = lazy(() => import('@/features/wiki/WikiPage').then(m => ({ default: m.WikiPage })))
const AppDatabasesPage = lazy(() => import('@/features/warehouse/AppDatabasesPage').then(m => ({ default: m.AppDatabasesPage })))
const SchemaPresetsPage = lazy(() => import('@/features/warehouse/SchemaPresetsPage').then(m => ({ default: m.SchemaPresetsPage })))
const ConceptMappingPage = lazy(() => import('@/features/warehouse/ConceptMappingPage').then(m => ({ default: m.ConceptMappingPage })))
const EtlPage = lazy(() => import('@/features/warehouse/EtlPage').then(m => ({ default: m.EtlPage })))
const SqlScriptsPage = lazy(() => import('@/features/warehouse/SqlScriptsPage').then(m => ({ default: m.SqlScriptsPage })))
const DqPage = lazy(() => import('@/features/warehouse/DqPage').then(m => ({ default: m.DqPage })))
const DataCatalogPage = lazy(() => import('@/features/warehouse/DataCatalogPage').then(m => ({ default: m.DataCatalogPage })))
const AppVersioningPage = lazy(() => import('@/features/versioning/AppVersioningPage').then(m => ({ default: m.AppVersioningPage })))
const WorkspacesPage = lazy(() => import('@/features/workspaces/WorkspacesPage').then(m => ({ default: m.WorkspacesPage })))
const WorkspaceHomePage = lazy(() => import('@/features/workspaces/WorkspaceHomePage').then(m => ({ default: m.WorkspaceHomePage })))
const WorkspaceSettingsPage = lazy(() => import('@/features/workspaces/WorkspaceSettingsPage').then(m => ({ default: m.WorkspaceSettingsPage })))

export function App() {
  const { darkMode, language, projectsLoaded, loadProjects, activeProjectUid } = useAppStore()
  const { organizationsLoaded, loadOrganizations } = useOrganizationStore()
  const { workspacesLoaded, loadWorkspaces } = useWorkspaceStore()
  const { dataSourcesLoaded, loadDataSources, mountProjectSources } = useDataSourceStore()
  const { cohortsLoaded, loadCohorts } = useCohortStore()
  const { pipelinesLoaded, loadPipelines } = usePipelineStore()
  const { catalogsLoaded, loadCatalogs, serviceMappingsLoaded, loadServiceMappings } = useCatalogStore()
  const { t, i18n } = useTranslation()

  useEffect(() => {
    loadOrganizations()
    loadWorkspaces()
    loadProjects()
    loadDataSources()
    loadCohorts()
    loadPipelines()
    loadCatalogs()
    loadServiceMappings()
  }, [loadOrganizations, loadWorkspaces, loadProjects, loadDataSources, loadCohorts, loadPipelines, loadCatalogs, loadServiceMappings])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  useEffect(() => {
    i18n.changeLanguage(language)
  }, [language, i18n])

  // Seed databases (Parquet files, concept mappings, ETL, datasets, dashboards)
  // from public/data/seed/seed.json after stores are loaded.
  const hasWorkspaces = useWorkspaceStore((s) => s._workspacesRaw.length > 0)
  useEffect(() => {
    if (!projectsLoaded || !dataSourcesLoaded || !hasWorkspaces) return
    seedDatabases()
      .then(() => {
        loadProjects()
        loadDataSources()
        loadCatalogs()
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, dataSourcesLoaded, hasWorkspaces])

  // Auto-mount data sources when entering a project
  useEffect(() => {
    if (activeProjectUid && dataSourcesLoaded) {
      mountProjectSources(activeProjectUid)
    }
  }, [activeProjectUid, dataSourcesLoaded, mountProjectSources])

  // Per-user recency: load this user's visit history, then record a visit whenever
  // the active workspace/project changes. Powers the "recent" lists' ordering.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const loadVisits = useVisitStore((s) => s.loadVisits)
  const recordVisit = useVisitStore((s) => s.recordVisit)
  useEffect(() => { loadVisits() }, [loadVisits])
  useEffect(() => {
    if (activeWorkspaceId) recordVisit('workspace', activeWorkspaceId)
  }, [activeWorkspaceId, recordVisit])
  useEffect(() => {
    if (activeProjectUid) recordVisit('project', activeProjectUid)
  }, [activeProjectUid, recordVisit])

  if (!organizationsLoaded || !workspacesLoaded || !projectsLoaded || !dataSourcesLoaded || !cohortsLoaded || !pipelinesLoaded || !catalogsLoaded || !serviceMappingsLoaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('app.loading')}</p>
        </div>
      </div>
    )
  }

  return (
    <SidebarProvider className="!min-h-0 h-screen">
      <VersionCheckDialog />
      <AppSidebar />
      <SidebarInset className="flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-hidden">
          <Suspense fallback={
            <div className="flex h-full items-center justify-center">
              <Loader2 size={24} className="animate-spin text-muted-foreground" />
            </div>
          }>
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
            <Route path="/workspaces/:wsUid/warehouse/concept-mapping/:mappingProjectId" element={<WorkspaceGuard><ConceptMappingPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/data-quality" element={<WorkspaceGuard><DqPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/data-quality/:ruleSetId" element={<WorkspaceGuard><DqPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/etl" element={<WorkspaceGuard><EtlPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/etl/:pipelineId" element={<WorkspaceGuard><EtlPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/sql-scripts" element={<WorkspaceGuard><SqlScriptsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/sql-scripts/:collectionId" element={<WorkspaceGuard><SqlScriptsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/catalog" element={<WorkspaceGuard><DataCatalogPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/catalog/:catalogId" element={<WorkspaceGuard><DataCatalogPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/versioning" element={<WorkspaceGuard><AppVersioningPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/settings" element={<WorkspaceGuard><WorkspaceSettingsPage /></WorkspaceGuard>} />

            {/* Project-level routes (nested under workspace) */}
            <Route path="/workspaces/:wsUid/projects/:uid" element={<WorkspaceGuard><ProjectGuard><Navigate to="summary" replace /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/summary" element={<WorkspaceGuard><ProjectGuard><SummaryPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/pipeline" element={<WorkspaceGuard><ProjectGuard><PipelinePage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/ide" element={<WorkspaceGuard><ProjectGuard><IdePage /></ProjectGuard></WorkspaceGuard>} />

            {/* Project warehouse routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/databases" element={<WorkspaceGuard><ProjectGuard><DatabasesPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/concepts" element={<WorkspaceGuard><ProjectGuard><ConceptsPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/cohorts" element={<WorkspaceGuard><ProjectGuard><CohortListPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/cohorts/:cohortId" element={<WorkspaceGuard><ProjectGuard><CohortBuilderPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/patient-data" element={<WorkspaceGuard><ProjectGuard><PatientDataPage /></ProjectGuard></WorkspaceGuard>} />

            {/* Project lab routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/lab/datasets" element={<WorkspaceGuard><ProjectGuard><DatasetsPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/dashboards" element={<WorkspaceGuard><ProjectGuard><LabDashboardsPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/dashboards/:dashboardId" element={<WorkspaceGuard><ProjectGuard><DashboardPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/reports" element={<WorkspaceGuard><ProjectGuard><ReportsPage /></ProjectGuard></WorkspaceGuard>} />

            {/* Project common routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/versioning" element={<WorkspaceGuard><ProjectGuard><VersioningPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/settings" element={<WorkspaceGuard><ProjectGuard><ProjectSettingsPage /></ProjectGuard></WorkspaceGuard>} />

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
          </Suspense>
        </main>
        <StatusBar />
      </SidebarInset>
    </SidebarProvider>
  )
}
