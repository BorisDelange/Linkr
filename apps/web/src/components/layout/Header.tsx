import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useEtlStore } from '@/stores/etl-store'
import { Sun, Moon, Globe, Trash2 } from 'lucide-react'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

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
  'warehouse/schema-presets': 'app_warehouse.nav_schema_presets',
  'warehouse/concept-mapping': 'app_warehouse.nav_concept_mapping',
  'warehouse/etl': 'app_warehouse.nav_etl',
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
  const {
    activeProjectName,
    activeProjectUid,
    closeProject,
    darkMode,
    toggleDarkMode,
    language,
    setLanguage,
    user,
    logout,
  } = useAppStore()
  const { activeWorkspaceName } = useWorkspaceStore()
  const dashboards = useDashboardStore((s) => s.dashboards)
  const etlPipelines = useEtlStore((s) => s.etlPipelines)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)

  const handleLanguageToggle = () => {
    const newLang = language === 'en' ? 'fr' : 'en'
    setLanguage(newLang)
    i18n.changeLanguage(newLang)
  }

  const handleResetData = async () => {
    // Clear IndexedDB
    const databases = await indexedDB.databases()
    for (const db of databases) {
      if (db.name) indexedDB.deleteDatabase(db.name)
    }
    // Clear localStorage
    localStorage.clear()
    // Reload the app
    window.location.href = '/'
  }

  const getPageLabel = () => {
    // Check project-level routes: /workspaces/:wsUid/projects/:uid/segment
    const projectMatch = location.pathname.match(/^\/workspaces\/[^/]+\/projects\/[^/]+\/(.+)$/)
    if (projectMatch) {
      const segment = projectMatch[1]

      // Dashboard editor: show dashboard name
      const dashMatch = segment.match(/^lab\/dashboards\/(.+)$/)
      if (dashMatch) {
        const dash = dashboards.find((d) => d.id === dashMatch[1])
        return dash?.name ?? t('project_nav.dashboards')
      }

      const key = projectSegmentTitleKeys[segment]
      return key ? t(key) : segment
    }

    // Check workspace-level routes: /workspaces/:wsUid/segment
    const wsMatch = location.pathname.match(/^\/workspaces\/[^/]+\/(.+)$/)
    if (wsMatch) {
      const segment = wsMatch[1]

      // ETL pipeline editor: show pipeline name
      const etlMatch = segment.match(/^warehouse\/etl\/(.+)$/)
      if (etlMatch) {
        const pipeline = etlPipelines.find((p) => p.id === etlMatch[1])
        return pipeline?.name ?? t('app_warehouse.nav_etl')
      }

      const key = workspaceSegmentTitleKeys[segment]
      return key ? t(key) : segment
    }

    // Check app-level routes (exact match, then prefix match for sub-routes)
    const key = routeTitleKeys[location.pathname]
      ?? Object.entries(routeTitleKeys).find(([path]) => path !== '/' && location.pathname.startsWith(path + '/'))?.[1]
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
            <Globe size={14} />
            {language.toUpperCase()}
          </Button>

          <Button variant="ghost" size="icon-sm" onClick={toggleDarkMode}>
            {darkMode ? <Sun size={15} /> : <Moon size={15} />}
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => setResetDialogOpen(true)}>
                <Trash2 size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('reset.tooltip')}</TooltipContent>
          </Tooltip>

          <div className="ml-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="rounded-full">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-primary text-[11px] font-medium text-primary-foreground">
                      {user?.username?.charAt(0).toUpperCase() ?? 'U'}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium">{user?.username ?? 'User'}</p>
                    <p className="text-xs text-muted-foreground">
                      {user?.email ?? ''}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/profile')}>
                  {t('user_menu.profile')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout}>
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
