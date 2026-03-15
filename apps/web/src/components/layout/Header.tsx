import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useEtlStore } from '@/stores/etl-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useCohortStore } from '@/stores/cohort-store'
import { useDqStore } from '@/stores/dq-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { SCHEMA_PRESETS } from '@/lib/schema-presets'
import { clearAllData } from '@/lib/version-check'
import { Sun, Moon, Languages, Trash2, User, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  const activeProjectName = useAppStore((s) => s.activeProjectName)
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const closeProject = useAppStore((s) => s.closeProject)
  const darkMode = useAppStore((s) => s.darkMode)
  const toggleDarkMode = useAppStore((s) => s.toggleDarkMode)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const user = useAppStore((s) => s.user)
  const logout = useAppStore((s) => s.logout)
  const activeWorkspaceName = useWorkspaceStore((s) => s.activeWorkspaceName)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)

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

  // Only subscribe to the store whose entity is currently displayed
  const dashboardName = useDashboardStore((s) => dashboardId ? s.dashboards.find((d) => d.id === dashboardId)?.name : undefined)
  const cohortName = useCohortStore((s) => cohortId ? s.cohorts.find((c) => c.id === cohortId)?.name : undefined)
  const etlName = useEtlStore((s) => etlId ? s.etlPipelines.find((p) => p.id === etlId)?.name : undefined)
  const sqlName = useSqlScriptsStore((s) => sqlId ? s.collections.find((c) => c.id === sqlId)?.name : undefined)
  const catalogName = useCatalogStore((s) => catalogId ? s.catalogs.find((c) => c.id === catalogId)?.name : undefined)
  const cmName = useConceptMappingStore((s) => cmId ? s.mappingProjects.find((p) => p.id === cmId)?.name : undefined)
  const dqName = useDqStore((s) => dqId ? s.dqRuleSets.find((r) => r.id === dqId)?.name : undefined)

  const handleLanguageToggle = () => {
    const newLang = language === 'en' ? 'fr' : 'en'
    setLanguage(newLang)
    i18n.changeLanguage(newLang)
  }

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

      if (etlId) return etlName ?? t('app_warehouse.nav_etl')
      if (sqlId) return sqlName ?? t('app_warehouse.nav_sql_scripts')
      if (catalogId) return catalogName ?? t('app_warehouse.nav_catalog')
      if (cmId) return cmName ?? t('app_warehouse.nav_concept_mapping')
      if (dqId) return dqName ?? t('app_warehouse.nav_data_quality')

      // Schema detail: show preset label
      const schemaMatch = segment.match(/^warehouse\/schemas\/(.+)$/)
      if (schemaMatch) {
        const preset = SCHEMA_PRESETS[schemaMatch[1]]
        return preset?.presetLabel ?? schemaMatch[1]
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
          <h1 className="text-[13px] font-medium text-foreground">
            {getPageLabel()}
          </h1>
          {activeWorkspaceName && (
            <>
              <Separator orientation="vertical" className="!h-4" />
              <Badge
                variant="outline"
                className="cursor-pointer text-[11px] transition-colors hover:bg-accent"
                onClick={() => {
                  if (activeProjectUid) closeProject()
                  const wsId = useWorkspaceStore.getState().activeWorkspaceId
                  if (wsId) navigate(`/workspaces/${wsId}/home`)
                }}
              >
                {activeWorkspaceName}
              </Badge>
            </>
          )}
          {activeProjectName && (
            <>
              <Separator orientation="vertical" className="!h-4" />
              <Badge variant="secondary" className="text-[11px]">{activeProjectName}</Badge>
            </>
          )}
        </div>

        <div className="flex items-center gap-0.5">
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
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium">{displayName}</p>
                    <p className="text-xs text-muted-foreground">
                      {user?.username ?? ''}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/profile')}>
                  <User size={14} />
                  {t('user_menu.profile')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setResetDialogOpen(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t('user_menu.reset_data')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout}>
                  <LogOut size={14} />
                  {t('user_menu.sign_out')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('reset.title')}</DialogTitle>
            <DialogDescription asChild>
              <div className="mt-3 space-y-3">
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
