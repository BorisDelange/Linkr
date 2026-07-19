import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { LocalizedString } from '@/types'
import { useLocation, useNavigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useAuthStore } from '@/stores/auth-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useEtlStore } from '@/stores/etl-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useCohortStore } from '@/stores/cohort-store'
import { useDqStore } from '@/stores/dq-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { localized } from '@/lib/localized'
import { resolveByIdPrefix } from '@/lib/short-id'
import { SCHEMA_PRESETS } from '@/lib/schema-presets'
import { paths } from '@/lib/paths'
import { clearAllData } from '@/lib/version-check'
import { Sun, Moon, Languages, Trash2, LogOut, Building2, FolderOpen, Settings, Settings2, ArrowLeft, BookOpen, ArrowRightLeft, MoreHorizontal, LayoutDashboard, UsersRound, Workflow, SquareTerminal, ShieldCheck, Puzzle, FileSpreadsheet, Pencil, Download, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { EntityActionsMenu } from '@/components/ui/entity-actions-menu'
import { useMappingProjectActions } from '@/features/warehouse/concept-mapping/use-mapping-project-actions'
import { useDashboardActions } from '@/features/projects/lab/use-dashboard-actions'
import { useCohortActions } from '@/features/projects/warehouse/cohorts/use-cohort-actions'
import { useEtlActions } from '@/features/warehouse/etl/use-etl-actions'
import { useSqlCollectionActions } from '@/features/warehouse/sql-scripts/use-sql-collection-actions'
import { usePluginActions } from '@/features/settings/use-plugin-actions'
import { useCatalogActions } from '@/features/warehouse/catalog/use-catalog-actions'
import { useDqRuleSetActions } from '@/features/warehouse/data-quality/use-dq-rule-set-actions'
import { useSchemaPresetActions, toSchemaPresetItem } from '@/features/warehouse/use-schema-preset-actions'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CreateProjectDialog } from '@/features/projects/CreateProjectDialog'
import { EditWorkspaceDialog } from '@/features/workspaces/EditWorkspaceDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const routeTitleKeys: Record<string, string> = {
  '/': 'nav.home',
  '/workspaces': 'nav.workspaces',
  '/catalog': 'nav.catalog',
  '/settings': 'nav.settings',
  '/profile': 'user_menu.profile',
}

const workspaceSegmentTitleKeys: Record<string, string> = {
  'home': 'workspace_nav.home',
  'projects': 'workspace_nav.projects',
  'wiki': 'workspace_nav.wiki',
  'plugins': 'workspace_nav.plugins',
  'warehouse/databases': 'app_warehouse.nav_databases',
  'warehouse/schemas': 'app_warehouse.nav_schemas',
  'warehouse/schema-presets': 'app_warehouse.nav_schema_presets',
  'warehouse/concept-mapping': 'app_warehouse.nav_concept_mapping',
  'warehouse/data-quality': 'app_warehouse.nav_data_quality',
  'warehouse/etl': 'app_warehouse.nav_etl',
  'warehouse/sql-scripts': 'app_warehouse.nav_sql_scripts',
  'warehouse/catalog': 'app_warehouse.nav_catalog',
  'versioning': 'workspace_nav.versioning',
  'settings': 'workspace_nav.settings',
}

const projectSegmentTitleKeys: Record<string, string> = {
  'summary': 'project_nav.summary',
  'pipeline': 'project_nav.pipeline',
  'ide': 'project_nav.ide',
  'warehouse/databases': 'project_nav.databases',
  'warehouse/concepts': 'project_nav.concepts',
  'warehouse/cohorts': 'project_nav.cohorts',
  'warehouse/patient-data': 'project_nav.patient_data',
  'lab/datasets': 'project_nav.datasets',
  'lab/dashboards': 'project_nav.dashboards',
  'lab/reports': 'project_nav.reports',
  'versioning': 'project_nav.versioning',
  'settings': 'project_nav.project_settings',
}

export function Header() {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const activeProjectRaw = useAppStore((s) => s._projectsRaw.find((p) => p.uid === s.activeProjectUid))
  const activeProjectNameRaw = activeProjectRaw?.name
  const deleteProject = useAppStore((s) => s.deleteProject)
  const closeProject = useAppStore((s) => s.closeProject)
  const darkMode = useAppStore((s) => s.darkMode)
  const toggleDarkMode = useAppStore((s) => s.toggleDarkMode)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const user = useAppStore((s) => s.user)
  const appLogout = useAppStore((s) => s.logout)
  const authLogout = useAuthStore((s) => s.logout)
  const isServerMode = useAuthStore((s) => s.isServerMode)
  const logout = () => {
    appLogout()
    // In server mode, also clear JWT tokens so AuthGate returns to the login page.
    if (isServerMode) authLogout()
  }
  const activeWorkspaceRaw = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === s.activeWorkspaceId))
  const activeWorkspaceNameRaw = activeWorkspaceRaw?.name
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)
  // Resolve names live from the raw entities so they follow the active language and renames.
  const activeProjectName = activeProjectNameRaw ? localized(activeProjectNameRaw, language) : (useAppStore.getState().activeProjectName ?? undefined)
  const activeWorkspaceName = activeWorkspaceNameRaw ? localized(activeWorkspaceNameRaw, language) : (useWorkspaceStore.getState().activeWorkspaceName ?? undefined)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [editWorkspaceOpen, setEditWorkspaceOpen] = useState(false)
  const [editProjectOpen, setEditProjectOpen] = useState(false)
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false)
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // --- Entity name resolution (only read the store that matches the current route) ---
  const pathname = location.pathname

  // Project-level detail routes
  const dashboardId = pathname.match(/\/projects\/[^/]+\/lab\/dashboards\/([^/]+)/)?.[1]
  const cohortId = pathname.match(/\/projects\/[^/]+\/warehouse\/cohorts\/([^/]+)/)?.[1]

  // Workspace-level detail routes
  const etlId = pathname.match(/\/workspaces\/[^/]+\/warehouse\/etl\/([^/]+)$/)?.[1]
  const sqlId = pathname.match(/\/workspaces\/[^/]+\/warehouse\/sql-scripts\/([^/]+)$/)?.[1]
  const catalogId = pathname.match(/\/workspaces\/[^/]+\/warehouse\/catalog\/([^/]+)$/)?.[1]
  const cmId = pathname.match(/\/workspaces\/[^/]+\/warehouse\/concept-mapping\/([^/]+)$/)?.[1]
  const dqId = pathname.match(/\/workspaces\/[^/]+\/warehouse\/data-quality\/([^/]+)$/)?.[1]
  const schemaId = pathname.match(/\/workspaces\/[^/]+\/warehouse\/schemas\/([^/]+)$/)?.[1]

  // Detail pages get a back arrow before the title that returns to their list view. Each list
  // path is the detail path with the trailing :id segment removed.
  const backToListPath = (() => {
    const detailId = dashboardId ?? cohortId ?? etlId ?? sqlId ?? catalogId ?? cmId ?? dqId ?? schemaId
    if (!detailId) return null
    const idx = pathname.lastIndexOf(`/${detailId}`)
    return idx > 0 ? pathname.slice(0, idx) : null
  })()

  // Only subscribe to the store whose entity is currently displayed. URLs carry a short id
  // prefix (see short-id.ts), so resolve by prefix — an exact `id === param` match misses the
  // shortened id and the badge would silently fall back to the generic page title.
  const dashboardEntity = useDashboardStore((s) => dashboardId ? resolveByIdPrefix(s.dashboards, dashboardId, (d) => d.id) : undefined)
  const cohortEntity = useCohortStore((s) => cohortId ? resolveByIdPrefix(s.cohorts, cohortId, (c) => c.id) : undefined)
  const etlEntity = useEtlStore((s) => etlId ? resolveByIdPrefix(s.etlPipelines, etlId, (p) => p.id) : undefined)
  const sqlEntity = useSqlScriptsStore((s) => sqlId ? resolveByIdPrefix(s.collections, sqlId, (c) => c.id) : undefined)
  const catalogEntity = useCatalogStore((s) => catalogId ? resolveByIdPrefix(s.catalogs, catalogId, (c) => c.id) : undefined)
  const cmProject = useConceptMappingStore((s) => cmId ? resolveByIdPrefix(s.mappingProjects, cmId, (p) => p.id) : undefined)
  const dqEntity = useDqStore((s) => dqId ? resolveByIdPrefix(s.dqRuleSets, dqId, (r) => r.id) : undefined)
  const schemaPreset = useSchemaPresetStore((s) => schemaId ? resolveByIdPrefix(s.presets, schemaId, (p) => p.presetId) : undefined)

  // Plugin editor is driven by store state (not a route). When a plugin is open,
  // surface its name as a header badge with the same actions as any entity.
  const editingPluginId = usePluginEditorStore((s) => s.editingPluginId)
  const editingPluginFiles = usePluginEditorStore((s) => s.files)
  const editingPluginIsSystem = usePluginEditorStore((s) => s.isSystemPlugin)
  const closePluginEditor = usePluginEditorStore((s) => s.closeEditor)
  const editingPluginGitRemote = usePluginEditorStore((s) => s.pluginList.find((p) => p.id === s.editingPluginId)?.gitRemoteConfig)
  const pluginItem = useMemo(() => {
    if (!editingPluginId) return undefined
    try {
      const m = JSON.parse(editingPluginFiles['plugin.json'] ?? '{}')
      return { id: editingPluginId, name: (m.name ?? editingPluginId) as LocalizedString | string, gitRemoteConfig: editingPluginGitRemote }
    } catch {
      return { id: editingPluginId, name: editingPluginId as string, gitRemoteConfig: editingPluginGitRemote }
    }
  }, [editingPluginId, editingPluginFiles, editingPluginGitRemote])

  const dashboardName = dashboardEntity?.name != null ? localized(dashboardEntity.name, language) : undefined
  const cohortName = cohortEntity?.name
  const etlName = etlEntity?.name
  const sqlName = sqlEntity?.name
  const catalogName = catalogEntity?.name
  const cmName = cmProject?.name
  const dqName = dqEntity?.name

  const mappingActions = useMappingProjectActions()
  const dashboardActions = useDashboardActions()
  const cohortActions = useCohortActions()
  const etlActions = useEtlActions()
  const sqlActions = useSqlCollectionActions()
  const catalogActions = useCatalogActions()
  const dqActions = useDqRuleSetActions()
  const schemaActions = useSchemaPresetActions()
  const schemaItem = schemaPreset ? toSchemaPresetItem(schemaPreset) : undefined
  const pluginActions = usePluginActions()
  const [pluginMenuOpen, setPluginMenuOpen] = useState(false)
  const [cmMenuOpen, setCmMenuOpen] = useState(false)
  const [dashMenuOpen, setDashMenuOpen] = useState(false)
  const [cohortMenuOpen, setCohortMenuOpen] = useState(false)
  const [etlMenuOpen, setEtlMenuOpen] = useState(false)
  const [sqlMenuOpen, setSqlMenuOpen] = useState(false)
  const [catalogMenuOpen, setCatalogMenuOpen] = useState(false)
  const [dqMenuOpen, setDqMenuOpen] = useState(false)
  const [schemaMenuOpen, setSchemaMenuOpen] = useState(false)

  // After deleting the entity from the header, leave its (now-orphaned) detail
  // page for the list — otherwise the stale id lingers in the URL and the next
  // relative navigation resolves wrong (nests under the deleted id).
  const handleEntityDeleted = () => {
    if (backToListPath) navigate(backToListPath)
  }

  const handleLanguageToggle = () => {
    const newLang = language === 'en' ? 'fr' : 'en'
    setLanguage(newLang)
    i18n.changeLanguage(newLang)
  }

  // Only reachable in front-only mode (the menu item is hidden in server mode),
  // where IndexedDB is the sole data store.
  const handleResetData = () => clearAllData()

  // Build display name and initials from firstName/lastName
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ')
  const displayName = fullName || user?.username || 'User'
  const initials = fullName
    ? [user?.firstName, user?.lastName].filter(Boolean).map((n) => n!.charAt(0).toUpperCase()).join('')
    : (user?.username?.charAt(0).toUpperCase() ?? 'U')

  const getPageLabel = () => {
    // Check project-level routes: /workspaces/:wsUid/projects/:uid/segment
    const projectMatch = pathname.match(/^\/workspaces\/[^/]+\/projects\/[^/]+\/(.+)$/)
    if (projectMatch) {
      const segment = projectMatch[1]

      if (dashboardId) return dashboardName ?? t('project_nav.dashboards')
      if (cohortId) return cohortName ?? t('project_nav.cohorts')

      const key = projectSegmentTitleKeys[segment]
      return key ? t(key) : segment
    }

    // Check workspace-level routes: /workspaces/:wsUid/segment
    const wsMatch = pathname.match(/^\/workspaces\/[^/]+\/(.+)$/)
    if (wsMatch) {
      const segment = wsMatch[1]

      if (etlId) return etlName ? localized(etlName, language) : t('app_warehouse.nav_etl')
      if (sqlId) return sqlName ? localized(sqlName, language) : t('app_warehouse.nav_sql_scripts')
      if (catalogId) return catalogName ? localized(catalogName, language) : t('app_warehouse.nav_catalog')
      if (cmId) return cmName ? localized(cmName, language) : t('app_warehouse.nav_concept_mapping')
      if (dqId) return dqName ? localized(dqName, language) : t('app_warehouse.nav_data_quality')

      // Schema detail: show preset label
      const schemaMatch = segment.match(/^warehouse\/schemas\/(.+)$/)
      if (schemaMatch) {
        const preset = SCHEMA_PRESETS[schemaMatch[1]]
        return preset?.presetLabel ? localized(preset.presetLabel, language) : schemaMatch[1]
      }

      const key = workspaceSegmentTitleKeys[segment]
      return key ? t(key) : segment
    }

    // Check app-level routes (exact match, then prefix match for sub-routes)
    const key = routeTitleKeys[pathname]
      ?? Object.entries(routeTitleKeys).find(([path]) => path !== '/' && pathname.startsWith(path + '/'))?.[1]
    return key ? t(key) : t('nav.home')
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-2.5">
          {(backToListPath || pluginItem) && (
            <button
              onClick={() => { if (pluginItem) closePluginEditor(); else if (backToListPath) navigate(backToListPath) }}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t('common.back')}
            >
              <ArrowLeft size={15} />
            </button>
          )}
          {pluginItem ? (
            <EntityActionsMenu
              item={pluginItem}
              {...pluginActions}
              syncScope="user-plugins"
              canEdit={!editingPluginIsSystem}
              canDelete={!editingPluginIsSystem}
              align="start"
              onDeleted={closePluginEditor}
              open={pluginMenuOpen}
              onOpenChange={setPluginMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <Puzzle size={10} className="text-muted-foreground" />
                  {localized(pluginItem.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : cmProject ? (
            <EntityActionsMenu
              item={cmProject}
              {...mappingActions}
              align="start"
              onDeleted={handleEntityDeleted}
              open={cmMenuOpen}
              onOpenChange={setCmMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <ArrowRightLeft size={10} className="text-muted-foreground" />
                  {localized(cmProject.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : dashboardEntity ? (
            <EntityActionsMenu
              item={dashboardEntity}
              {...dashboardActions}
              align="start"
              onDeleted={handleEntityDeleted}
              open={dashMenuOpen}
              onOpenChange={setDashMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <LayoutDashboard size={10} className="text-muted-foreground" />
                  {localized(dashboardEntity.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : cohortEntity ? (
            <EntityActionsMenu
              item={cohortEntity}
              {...cohortActions}
              align="start"
              onDeleted={handleEntityDeleted}
              open={cohortMenuOpen}
              onOpenChange={setCohortMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <UsersRound size={10} className="text-muted-foreground" />
                  {cohortEntity.name}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : etlEntity ? (
            <EntityActionsMenu
              item={etlEntity}
              {...etlActions}
              syncScope="etl-pipelines"
              align="start"
              onDeleted={handleEntityDeleted}
              open={etlMenuOpen}
              onOpenChange={setEtlMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <Workflow size={10} className="text-muted-foreground" />
                  {localized(etlEntity.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : sqlEntity ? (
            <EntityActionsMenu
              item={sqlEntity}
              {...sqlActions}
              syncScope="sql-script-collections"
              align="start"
              onDeleted={handleEntityDeleted}
              open={sqlMenuOpen}
              onOpenChange={setSqlMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <SquareTerminal size={10} className="text-muted-foreground" />
                  {localized(sqlEntity.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : catalogEntity ? (
            <EntityActionsMenu
              item={catalogEntity}
              {...catalogActions}
              syncScope="data-catalogs"
              align="start"
              onDeleted={handleEntityDeleted}
              open={catalogMenuOpen}
              onOpenChange={setCatalogMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <BookOpen size={10} className="text-muted-foreground" />
                  {localized(catalogEntity.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : dqEntity ? (
            <EntityActionsMenu
              item={dqEntity}
              {...dqActions}
              syncScope="dq-rule-sets"
              align="start"
              onDeleted={handleEntityDeleted}
              open={dqMenuOpen}
              onOpenChange={setDqMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <ShieldCheck size={10} className="text-muted-foreground" />
                  {localized(dqEntity.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : schemaItem ? (
            <EntityActionsMenu
              item={schemaItem}
              {...schemaActions}
              align="start"
              onDeleted={handleEntityDeleted}
              open={schemaMenuOpen}
              onOpenChange={setSchemaMenuOpen}
              trigger={
                <Badge
                  variant="outline"
                  className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-foreground/80 border-border bg-muted transition-colors hover:bg-accent"
                  aria-label={t('common.actions')}
                >
                  <FileSpreadsheet size={10} className="text-muted-foreground" />
                  {localized(schemaItem.name, language)}
                  <MoreHorizontal size={12} className="text-muted-foreground" />
                </Badge>
              }
            />
          ) : (
            <h1 className="text-[13px] font-medium text-foreground">
              {getPageLabel()}
            </h1>
          )}
          {activeWorkspaceName && (
            <>
              <Separator orientation="vertical" className="!h-4" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Badge
                    variant="outline"
                    className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-amber-600 border-amber-200 bg-amber-50 transition-colors hover:bg-amber-100 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950 dark:hover:bg-amber-900"
                  >
                    <Building2 size={10} />
                    {activeWorkspaceName}
                    <MoreHorizontal size={12} className="text-muted-foreground" />
                  </Badge>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => {
                    if (activeProjectUid) closeProject()
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId) navigate(paths.workspaceHome(wsId))
                  }}>
                    <LayoutDashboard size={14} />
                    {t('workspace_nav.home')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditWorkspaceOpen(true)}>
                    <Pencil size={14} />
                    {t('common.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId) navigate(paths.workspaceVersioning(wsId, 'export'))
                  }}>
                    <Download size={14} />
                    {t('common.export')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId) navigate(paths.workspaceVersioning(wsId, 'git'))
                  }}>
                    <GitBranch size={14} />
                    {t('common.versioning')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId) navigate(paths.workspaceSettings(wsId))
                  }}>
                    <Settings2 size={14} />
                    {t('nav.settings')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDeleteWorkspaceOpen(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} className="text-destructive" />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          {activeProjectName && (
            <>
              <Separator orientation="vertical" className="!h-4" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Badge
                    variant="outline"
                    className="cursor-pointer translate-y-px gap-1 py-0 text-[11px] text-blue-700 border-blue-200 bg-blue-50 transition-colors hover:bg-blue-100 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950 dark:hover:bg-blue-900"
                  >
                    <FolderOpen size={10} />
                    {activeProjectName}
                    <MoreHorizontal size={12} className="text-muted-foreground" />
                  </Badge>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId && activeProjectUid) navigate(paths.projectSummary(wsId, activeProjectUid))
                  }}>
                    <LayoutDashboard size={14} />
                    {t('project_nav.summary')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditProjectOpen(true)}>
                    <Pencil size={14} />
                    {t('common.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId && activeProjectUid) navigate(paths.projectVersioning(wsId, activeProjectUid, 'export'))
                  }}>
                    <Download size={14} />
                    {t('common.export')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId && activeProjectUid) navigate(paths.projectVersioning(wsId, activeProjectUid, 'git'))
                  }}>
                    <GitBranch size={14} />
                    {t('common.versioning')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const wsId = useWorkspaceStore.getState().activeWorkspaceId
                    if (wsId && activeProjectUid) navigate(paths.projectSettings(wsId, activeProjectUid))
                  }}>
                    <Settings2 size={14} />
                    {t('nav.settings')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDeleteProjectOpen(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} className="text-destructive" />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            asChild
            title={t('header.docs')}
            className="gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400 dark:bg-amber-950 dark:border-amber-800 dark:hover:bg-amber-900"
          >
            <a
              href={language === 'fr' ? 'https://linkr.interhop.org/docs/' : 'https://linkr.interhop.org/en/docs/'}
              target="_blank"
              rel="noopener noreferrer"
            >
              <BookOpen size={14} />
              {t('header.docs_short')}
            </a>
          </Button>

          <Button variant="ghost" size="sm" onClick={handleLanguageToggle} className="gap-1.5 text-xs">
            <Languages size={14} />
            {language.toUpperCase()}
          </Button>

          <Button variant="ghost" size="icon-sm" onClick={toggleDarkMode}>
            {darkMode ? <Sun size={15} /> : <Moon size={15} />}
          </Button>

          <div className="ml-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="rounded-full">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-primary text-[11px] font-medium text-primary-foreground">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium">{displayName}</p>
                    <p className="text-xs text-muted-foreground">
                      {user?.username ?? ''}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/profile')} className="cursor-pointer">
                  <Settings size={14} />
                  {t('user_menu.profile')}
                </DropdownMenuItem>
                {/* Front-only only: wipes local IndexedDB (the sole data store there).
                    In server mode the client keeps no data, so there's nothing to clear. */}
                {!isServerMode && (
                  <DropdownMenuItem
                    onClick={() => setResetDialogOpen(true)}
                    className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} className="text-destructive" />
                    {t('user_menu.reset_data')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="cursor-pointer">
                  <LogOut size={14} />
                  {t('user_menu.sign_out')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Workspace edit dialog (from the workspace badge menu) */}
      <EditWorkspaceDialog
        open={editWorkspaceOpen}
        onOpenChange={setEditWorkspaceOpen}
        workspace={activeWorkspaceRaw}
      />

      {/* Project edit dialog (from the project badge menu) */}
      <CreateProjectDialog
        open={editProjectOpen}
        editingProject={activeProjectRaw ?? undefined}
        onOpenChange={setEditProjectOpen}
      />

      {/* Delete workspace confirmation */}
      <AlertDialog
        open={deleteWorkspaceOpen}
        onOpenChange={(open) => { setDeleteWorkspaceOpen(open); if (!open) setDeleteConfirm('') }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workspaces.delete_workspace')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('workspaces.delete_workspace_description')}</p>
                <p className="text-sm">
                  {t('workspaces.delete_workspace_confirm')}{' '}
                  <span className="font-semibold text-foreground">{activeWorkspaceName}</span>
                </p>
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={activeWorkspaceName}
                  className="mt-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteConfirm !== activeWorkspaceName}
              className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
              onClick={async () => {
                const wsId = useWorkspaceStore.getState().activeWorkspaceId
                setDeleteWorkspaceOpen(false)
                if (activeProjectUid) closeProject()
                if (wsId) { await deleteWorkspace(wsId); navigate('/workspaces') }
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete project confirmation */}
      <AlertDialog
        open={deleteProjectOpen}
        onOpenChange={(open) => { setDeleteProjectOpen(open); if (!open) setDeleteConfirm('') }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('project_settings.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('project_settings.delete_confirm_description')}</p>
                <p className="text-sm">
                  {t('project_settings.delete_confirm_type')}{' '}
                  <span className="font-semibold text-foreground">{activeProjectName}</span>
                </p>
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={activeProjectName}
                  className="mt-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteConfirm !== activeProjectName}
              className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
              onClick={async () => {
                const wsId = useWorkspaceStore.getState().activeWorkspaceId
                const uid = activeProjectUid
                setDeleteProjectOpen(false)
                if (uid) {
                  await deleteProject(uid)
                  closeProject()
                  if (wsId) navigate(paths.workspaceHome(wsId))
                }
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('reset.title')}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p>{t('reset.description')}</p>
                <ul className="list-disc pl-4 text-xs space-y-1">
                  <li>{t('reset.item_projects')}</li>
                  <li>{t('reset.item_dashboards')}</li>
                  <li>{t('reset.item_files')}</li>
                  <li>{t('reset.item_preferences')}</li>
                </ul>
                <p className="font-medium text-destructive">{t('reset.warning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleResetData}>
              <Trash2 size={14} />
              {t('reset.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
