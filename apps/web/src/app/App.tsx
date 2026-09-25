import { useEffect, useState, useSyncExternalStore, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Routes, Route, Navigate, useLocation } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useVisitStore } from '@/stores/visit-store'
import { useUserDirectoryStore } from '@/stores/user-directory-store'
import { seedDatabases, hasPendingDataSeed } from '@/lib/seed-loader'
import { subscribeSeedProgress, isSeedRunning } from '@/lib/seed-progress'
import { isServerMode } from '@/lib/api-client'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/Sidebar'
import { BootScreen } from '@/components/layout/BootScreen'
import { PageLoading } from '@/components/layout/PageLoading'
import { Header } from '@/components/layout/Header'
import { StatusBar } from '@/components/layout/StatusBar'
import { EnvironmentsDialogHost } from '@/features/projects/files/EnvironmentsDialog'
import { WorkspaceGuard } from '@/app/WorkspaceGuard'
import { ProjectGuard } from '@/app/ProjectGuard'
import { VersionCheckDialog } from '@/components/layout/VersionCheckDialog'
import { DatabaseLoginPromptHost } from '@/features/database-logins/DatabaseLoginPromptHost'
// Pages are lazy-loaded so each route's heavy libs (vis-network, leaflet, xterm,
// xyflow, xlsx, recharts, katex…) ship in a per-route chunk and
// are fetched only when that page is opened — not in the initial bundle.
const HomePage = lazy(() => import('@/features/home/HomePage').then(m => ({ default: m.HomePage })))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage').then(m => ({ default: m.ProjectsPage })))
const SummaryPage = lazy(() => import('@/features/projects/SummaryPage').then(m => ({ default: m.SummaryPage })))
const PipelinePage = lazy(() => import('@/features/projects/PipelinePage').then(m => ({ default: m.PipelinePage })))
const DatabasesPage = lazy(() => import('@/features/projects/warehouse/DatabasesPage').then(m => ({ default: m.DatabasesPage })))
const ConceptsPage = lazy(() => import('@/features/projects/warehouse/ConceptsPage').then(m => ({ default: m.ConceptsPage })))
const CohortListPage = lazy(() => import('@/features/projects/warehouse/cohorts/CohortListPage').then(m => ({ default: m.CohortListPage })))
const CohortBuilderPage = lazy(() => import('@/features/projects/warehouse/cohorts/CohortBuilderPage').then(m => ({ default: m.CohortBuilderPage })))
const PatientDataListPage = lazy(() => import('@/features/projects/warehouse/PatientDataListPage').then(m => ({ default: m.PatientDataListPage })))
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
  const { i18n } = useTranslation()

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
  //
  // Front-only mode ONLY, and for the same reason phase 1 is gated in app-store:
  // in server mode the baseline belongs to the instance, not to a browser. This
  // phase gates on "some workspace exists" rather than on `isSeeded()`, so in
  // server mode it ran on EVERY load — including right after a catalog install
  // had created the workspace, re-seeding bundled Parquet on top of it.
  const hasWorkspaces = useWorkspaceStore((s) => s._workspacesRaw.length > 0)
  // Phase 2 used to run behind an already-rendered shell, so a first visitor got
  // a usable-looking app whose content was still downloading — lists read "empty"
  // rather than "loading". The boot screen now stays up until this resolves.
  // `null` until we know whether there is anything to install: a return visit
  // walks the manifests, finds every entity already flagged and finishes without
  // downloading, so gating the screen on the seed merely running would show an
  // "installing…" step on every single load.
  const [dataSeeded, setDataSeeded] = useState<boolean | null>(null)
  useEffect(() => {
    if (isServerMode() || !projectsLoaded || !dataSourcesLoaded || !hasWorkspaces) return
    let cancelled = false
    hasPendingDataSeed().then((pending) => {
      if (cancelled) return
      // Only a run that will really install anything raises the screen; otherwise
      // the seed still runs (it is what skips each entity) but stays out of sight.
      setDataSeeded(pending ? false : true)
      seedDatabases()
        .then(() => {
          loadProjects()
          // Forced: the seed writes each database's final `connected` status
          // straight to storage, and an unforced load joins the one already in
          // flight from mount — resolving with the pre-seed rows. The database
          // then sat at `configuring` for the session, reading as "Not connected"
          // with an empty Schema tab though its data was mounted and queryable.
          loadDataSources(true)
          // Same reason: the seed resolves each cohort's `dataSourceRef` into a
          // `dataSourceId` only once the databases exist, i.e. after this store
          // was filled from the pre-seed rows. Without this a seeded cohort keeps
          // an empty database for the whole session — name in italics on the
          // card, empty dropdown in the edit dialog — until the next reload.
          loadCohorts()
          loadCatalogs()
        })
        .finally(() => { if (!cancelled) setDataSeeded(true) })
    })
    return () => { cancelled = true }
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
  const loadDirectory = useUserDirectoryStore((s) => s.loadDirectory)
  useEffect(() => { loadVisits() }, [loadVisits])
  // Author names on cards resolve against this directory (id → current name).
  useEffect(() => { loadDirectory() }, [loadDirectory])
  // Defer the record so the re-sorted "recent" list don't visibly reshuffle on the
  // page being left before the router navigates away — a short delay hides it.
  useEffect(() => {
    if (!activeWorkspaceId) return
    const id = setTimeout(() => recordVisit('workspace', activeWorkspaceId), 400)
    return () => clearTimeout(id)
  }, [activeWorkspaceId, recordVisit])
  useEffect(() => {
    if (!activeProjectUid) return
    const id = setTimeout(() => recordVisit('project', activeProjectUid), 400)
    return () => clearTimeout(id)
  }, [activeProjectUid, recordVisit])

  // The guards open the workspace/project matching the URL, but only explicit
  // actions (back buttons, logo) closed them — so a browser back/forward out of
  // a project or workspace left the sidebar on the deeper level. Close whatever
  // the URL no longer contains. Stores are read via getState() so this only
  // fires on URL changes, not on openProject() calls that precede a navigate().
  const location = useLocation()
  useEffect(() => {
    const pathname = location.pathname
    if (useAppStore.getState().activeProjectUid && !/^\/workspaces\/[^/]+\/projects\/[^/]+/.test(pathname)) {
      useAppStore.getState().closeProject()
    }
    if (useWorkspaceStore.getState().activeWorkspaceId && !/^\/workspaces\/[^/]+/.test(pathname)) {
      useWorkspaceStore.getState().closeWorkspace()
    }
  }, [location.pathname])

  // The path alone, so that a page driving its own state through the query string
  // (a tab, a filter, a selected row) updates in place instead of remounting.
  const pageKey = location.pathname

  // Subscribed rather than read once: the seed advances outside React, and the
  // gate has to notice the moment it opens and the moment it closes.
  const seedRunning = useSyncExternalStore(subscribeSeedProgress, isSeedRunning)

  const storesLoading = !organizationsLoaded || !workspacesLoaded || !projectsLoaded
    || !dataSourcesLoaded || !cohortsLoaded || !pipelinesLoaded || !catalogsLoaded
    || !serviceMappingsLoaded
  // Phase 2 is front-only, and it only runs on a workspace that exists — anywhere
  // else there is nothing to wait for, so the screen must not gate on it.
  //
  // Two conditions, because neither covers the whole install on its own:
  // `dataSeeded === false` is phase 2 known to have work, and `seedRunning` keeps
  // the screen up across phase 1 AND the manifest read between the phases — the
  // gap where the app used to render for ~100ms, flashing the UI mid-install.
  const seedPending = !isServerMode() && (seedRunning || (hasWorkspaces && dataSeeded === false))

  if (storesLoading || seedPending) {
    return <BootScreen stage={storesLoading ? 'stores' : 'seed'} />
  }

  return (
    <SidebarProvider className="!min-h-0 h-screen">
      <VersionCheckDialog />
      {isServerMode() && <DatabaseLoginPromptHost />}
      <AppSidebar />
      <SidebarInset className="flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-hidden">
          {/* Keyed on the path so a navigation remounts the boundary.
              React Router navigates inside a transition, and React keeps the
              PREVIOUS page on screen for the whole of it rather than showing a
              fallback — which, with pages that pull a couple of MB of chunks,
              froze the old screen for seconds with nothing to say a new one was
              coming. Remounting opts this boundary out of that behaviour. */}
          <Suspense key={pageKey} fallback={<PageLoading />}>
          <Routes>
            {/* App-level routes */}
            <Route path="/" element={<HomePage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/settings/:tab?" element={<SettingsPage />} />
            <Route path="/profile" element={<ProfilePage />} />

            {/* Workspace-level routes */}
            <Route path="/workspaces/:wsUid" element={<WorkspaceGuard><Navigate to="home" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/home" element={<WorkspaceGuard><WorkspaceHomePage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects" element={<WorkspaceGuard><ProjectsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/wiki" element={<WorkspaceGuard><WikiPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/plugins" element={<WorkspaceGuard><PluginsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse" element={<WorkspaceGuard><Navigate to="databases" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/databases" element={<WorkspaceGuard><AppDatabasesPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/databases/:dbId" element={<WorkspaceGuard><AppDatabasesPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/databases/:dbId/cohorts/:cohortId" element={<WorkspaceGuard><AppDatabasesPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/schemas" element={<WorkspaceGuard><SchemaPresetsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/schemas/:schemaId" element={<WorkspaceGuard><SchemaPresetsPage /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/schema-presets" element={<WorkspaceGuard><Navigate to="../schemas" replace /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/concept-mapping" element={<WorkspaceGuard><ConceptMappingPage /></WorkspaceGuard>} />
            {/* Literal view segments before the parameterized :mappingProjectId route so they win the match. */}
            <Route path="/workspaces/:wsUid/warehouse/concept-mapping/projects" element={<WorkspaceGuard><ConceptMappingPage view="projects" /></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/warehouse/concept-mapping/overview" element={<WorkspaceGuard><ConceptMappingPage view="global" /></WorkspaceGuard>} />
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
            <Route path="/workspaces/:wsUid/settings/:tab?" element={<WorkspaceGuard><WorkspaceSettingsPage /></WorkspaceGuard>} />

            {/* Project-level routes (nested under workspace) */}
            <Route path="/workspaces/:wsUid/projects/:uid" element={<WorkspaceGuard><ProjectGuard><Navigate to="summary" replace /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/summary" element={<WorkspaceGuard><ProjectGuard><SummaryPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/pipeline" element={<WorkspaceGuard><ProjectGuard><PipelinePage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/ide" element={<WorkspaceGuard><ProjectGuard><IdePage /></ProjectGuard></WorkspaceGuard>} />

            {/* Project warehouse routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/databases" element={<WorkspaceGuard><ProjectGuard><DatabasesPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/databases/:dbId" element={<WorkspaceGuard><ProjectGuard><DatabasesPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/concepts" element={<WorkspaceGuard><ProjectGuard><ConceptsPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/cohorts" element={<WorkspaceGuard><ProjectGuard><CohortListPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/cohorts/:cohortId" element={<WorkspaceGuard><ProjectGuard><CohortBuilderPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/patient-data" element={<WorkspaceGuard><ProjectGuard><PatientDataListPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/warehouse/patient-data/:boardId" element={<WorkspaceGuard><ProjectGuard><PatientDataPage /></ProjectGuard></WorkspaceGuard>} />

            {/* Project lab routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/lab/datasets" element={<WorkspaceGuard><ProjectGuard><DatasetsPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/dashboards" element={<WorkspaceGuard><ProjectGuard><LabDashboardsPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/dashboards/:dashboardId" element={<WorkspaceGuard><ProjectGuard><DashboardPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/lab/reports" element={<WorkspaceGuard><ProjectGuard><ReportsPage /></ProjectGuard></WorkspaceGuard>} />

            {/* Project common routes */}
            <Route path="/workspaces/:wsUid/projects/:uid/versioning" element={<WorkspaceGuard><ProjectGuard><VersioningPage /></ProjectGuard></WorkspaceGuard>} />
            <Route path="/workspaces/:wsUid/projects/:uid/settings/:tab?" element={<WorkspaceGuard><ProjectGuard><ProjectSettingsPage /></ProjectGuard></WorkspaceGuard>} />

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
        <EnvironmentsDialogHost />
      </SidebarInset>
    </SidebarProvider>
  )
}
