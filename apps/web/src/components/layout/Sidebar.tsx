import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import {
  Home,
  FolderOpen,
  Settings,
  Users,
  BarChart3,
  UsersRound,
  Settings2,
  ArrowLeft,
  ArrowRightLeft,
  LayoutDashboard,
  Database,
  Warehouse,
  BookOpen,
  ShieldCheck,
  FlaskConical,
  Table2,
  Code,
  Workflow,
  GitBranch,
  FileSpreadsheet,
  FileText,
  Store,
  Puzzle,
  Building2,
  ChevronRight,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LinkrLogo } from '@/components/ui/linkr-logo'

// ── Shared nav types ──────────────────────────────────────────────

interface SegmentNavItem {
  segment: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  labelKey: string
  iconColor: string
}

interface SegmentNavGroup {
  type: 'group'
  labelKey: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  iconColor: string
  children: SegmentNavItem[]
  defaultOpen?: boolean
}

type SegmentNavEntry = SegmentNavItem | SegmentNavGroup

function isSegmentGroup(entry: SegmentNavEntry): entry is SegmentNavGroup {
  return 'type' in entry && entry.type === 'group'
}

// ── App-level nav (absolute paths) ───────────────────────────────

interface AppNavItem {
  path: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  labelKey: string
  iconColor?: string
}

const appNavItems: AppNavItem[] = [
  { path: '/', icon: Home, labelKey: 'nav.home', iconColor: 'text-blue-500' },
  { path: '/workspaces', icon: Building2, labelKey: 'nav.workspaces', iconColor: 'text-amber-500' },
  { path: '/catalog', icon: Store, labelKey: 'nav.catalog', iconColor: 'text-violet-500' },
]

const appBottomItems: AppNavItem[] = [
  { path: '/settings', icon: Settings, labelKey: 'nav.settings', iconColor: 'text-slate-400' },
]

// ── Workspace-level nav (segment-based) ──────────────────────────

const workspaceNavItems: SegmentNavEntry[] = [
  { segment: 'home', icon: Home, labelKey: 'workspace_nav.home', iconColor: 'text-blue-500' },
  { segment: 'projects', icon: FolderOpen, labelKey: 'workspace_nav.projects', iconColor: 'text-amber-500' },
  { segment: 'wiki', icon: BookOpen, labelKey: 'workspace_nav.wiki', iconColor: 'text-emerald-500' },
  { segment: 'plugins', icon: Puzzle, labelKey: 'workspace_nav.plugins', iconColor: 'text-pink-500' },
  {
    type: 'group',
    labelKey: 'workspace_nav.warehouse',
    icon: Warehouse,
    iconColor: 'text-teal-500',
    defaultOpen: true,
    children: [
      { segment: 'warehouse/schemas', icon: FileSpreadsheet, labelKey: 'app_warehouse.nav_schemas', iconColor: 'text-teal-500' },
      { segment: 'warehouse/databases', icon: Database, labelKey: 'app_warehouse.nav_databases', iconColor: 'text-teal-500' },
      { segment: 'warehouse/catalog', icon: BookOpen, labelKey: 'app_warehouse.nav_catalog', iconColor: 'text-teal-500' },
      { segment: 'warehouse/data-quality', icon: ShieldCheck, labelKey: 'app_warehouse.nav_data_quality', iconColor: 'text-teal-500' },
      { segment: 'warehouse/concept-mapping', icon: ArrowRightLeft, labelKey: 'app_warehouse.nav_concept_mapping', iconColor: 'text-teal-500' },
      { segment: 'warehouse/etl', icon: Workflow, labelKey: 'app_warehouse.nav_etl', iconColor: 'text-teal-500' },
    ],
  },
  { segment: 'versioning', icon: GitBranch, labelKey: 'workspace_nav.versioning', iconColor: 'text-orange-400' },
]

const workspaceBottomItems: SegmentNavItem[] = [
  { segment: 'settings', icon: Settings2, labelKey: 'workspace_nav.settings', iconColor: 'text-slate-400' },
]

// ── Project-level nav (segment-based) ────────────────────────────

const projectNavItems: SegmentNavEntry[] = [
  { segment: 'summary', icon: LayoutDashboard, labelKey: 'project_nav.summary', iconColor: 'text-blue-500' },
  { segment: 'ide', icon: Code, labelKey: 'project_nav.ide', iconColor: 'text-violet-500' },
  { segment: 'pipeline', icon: Workflow, labelKey: 'project_nav.pipeline', iconColor: 'text-orange-500' },
  {
    type: 'group',
    labelKey: 'project_nav.data_warehouse',
    icon: Warehouse,
    iconColor: 'text-teal-500',
    defaultOpen: true,
    children: [
      { segment: 'warehouse/databases', icon: Database, labelKey: 'project_nav.databases', iconColor: 'text-teal-500' },
      { segment: 'warehouse/concepts', icon: BookOpen, labelKey: 'project_nav.concepts', iconColor: 'text-teal-500' },
      { segment: 'warehouse/cohorts', icon: UsersRound, labelKey: 'project_nav.cohorts', iconColor: 'text-teal-500' },
      { segment: 'warehouse/patient-data', icon: Users, labelKey: 'project_nav.patient_data', iconColor: 'text-teal-500' },
    ],
  },
  {
    type: 'group',
    labelKey: 'project_nav.lab',
    icon: FlaskConical,
    iconColor: 'text-rose-500',
    defaultOpen: true,
    children: [
      { segment: 'lab/datasets', icon: Table2, labelKey: 'project_nav.datasets', iconColor: 'text-rose-500' },
      { segment: 'lab/dashboards', icon: BarChart3, labelKey: 'project_nav.dashboards', iconColor: 'text-rose-500' },
      { segment: 'lab/reports', icon: FileText, labelKey: 'project_nav.reports', iconColor: 'text-rose-500' },
    ],
  },
  { segment: 'versioning', icon: GitBranch, labelKey: 'project_nav.versioning', iconColor: 'text-orange-400' },
]

const projectBottomItems: SegmentNavItem[] = [
  { segment: 'settings', icon: Settings2, labelKey: 'project_nav.project_settings', iconColor: 'text-slate-400' },
]

// ── Component ────────────────────────────────────────────────────

export function AppSidebar() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { activeProjectUid, closeProject } = useAppStore()
  const { activeWorkspaceId, activeWorkspaceName, closeWorkspace } = useWorkspaceStore()
  const { state: sidebarState } = useSidebar()
  const isCollapsed = sidebarState === 'collapsed'

  // 3-way navigation level
  const level: 'app' | 'workspace' | 'project' =
    activeProjectUid ? 'project' :
    activeWorkspaceId ? 'workspace' :
    'app'

  // Base paths for segment-based items
  const wsBase = `/workspaces/${activeWorkspaceId}`
  const projBase = `${wsBase}/projects/${activeProjectUid}`

  const handleBackToProjects = () => {
    closeProject()
    navigate(`${wsBase}/projects`)
  }

  const handleBackToWorkspaces = () => {
    closeWorkspace()
    navigate('/workspaces')
  }

  const handleLogoClick = () => {
    if (activeProjectUid) closeProject()
    if (activeWorkspaceId) closeWorkspace()
  }

  // ── Render helpers for segment-based nav ───────────────────────

  const buildPath = (segment: string) =>
    level === 'project' ? `${projBase}/${segment}` : `${wsBase}/${segment}`

  const isPathActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/')

  const renderSegmentSubItem = (item: SegmentNavItem) => {
    const path = buildPath(item.segment)
    const isActive = isPathActive(path)
    return (
      <SidebarMenuSubItem key={item.segment}>
        <SidebarMenuSubButton asChild isActive={isActive}>
          <Link to={path}>
            <item.icon className={isActive ? '' : item.iconColor} />
            <span>{t(item.labelKey)}</span>
          </Link>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    )
  }

  const renderSegmentTopItem = (item: SegmentNavItem) => {
    const path = buildPath(item.segment)
    const isActive = isPathActive(path)
    return (
      <SidebarMenuItem key={item.segment}>
        <SidebarMenuButton asChild isActive={isActive} tooltip={t(item.labelKey)}>
          <Link to={path}>
            <item.icon className={isActive ? '' : item.iconColor} />
            <span>{t(item.labelKey)}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  const renderSegmentGroup = (entry: SegmentNavGroup) => {
    const isChildActive = entry.children.some(
      (child) => isPathActive(buildPath(child.segment)),
    )

    if (isCollapsed) {
      return (
        <SidebarMenuItem key={entry.labelKey}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton isActive={isChildActive} tooltip={t(entry.labelKey)}>
                <entry.icon className={isChildActive ? '' : entry.iconColor} />
                <span>{t(entry.labelKey)}</span>
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="min-w-[180px]">
              {entry.children.map((child) => {
                const path = buildPath(child.segment)
                const isActive = isPathActive(path)
                return (
                  <DropdownMenuItem
                    key={child.segment}
                    className={isActive ? 'bg-accent' : ''}
                    onClick={() => navigate(path)}
                  >
                    <child.icon size={14} className={isActive ? '' : child.iconColor} />
                    <span>{t(child.labelKey)}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      )
    }

    return (
      <Collapsible
        key={entry.labelKey}
        defaultOpen={entry.defaultOpen ?? isChildActive}
        className="group/collapsible"
      >
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip={t(entry.labelKey)}>
              <entry.icon className={entry.iconColor} />
              <span>{t(entry.labelKey)}</span>
              <ChevronRight size={14} className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              {entry.children.map((child) => renderSegmentSubItem(child))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    )
  }

  const renderSegmentNav = (entries: SegmentNavEntry[]) =>
    entries.map((entry) =>
      isSegmentGroup(entry) ? renderSegmentGroup(entry) : renderSegmentTopItem(entry),
    )

  // ── Render helpers for app-level nav (absolute paths) ──────────

  const renderAppItem = (item: AppNavItem) => {
    const isActive = item.path === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(item.path)
    return (
      <SidebarMenuItem key={item.path}>
        <SidebarMenuButton asChild isActive={isActive} tooltip={t(item.labelKey)}>
          <Link to={item.path}>
            <item.icon className={isActive ? '' : item.iconColor} />
            <span>{t(item.labelKey)}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  // ── Back button ────────────────────────────────────────────────

  const backButton = level === 'project' ? (
    <div className="mx-2 mb-1 group-data-[collapsible=icon]:hidden">
      <button
        onClick={handleBackToProjects}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <ArrowLeft size={12} />
        {t('project_nav.back_to_projects')}
      </button>
    </div>
  ) : level === 'workspace' ? (
    <div className="mx-2 mb-1 group-data-[collapsible=icon]:hidden">
      <button
        onClick={handleBackToWorkspaces}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <ArrowLeft size={12} />
        {t('workspace_nav.back_to_workspaces')}
      </button>
    </div>
  ) : null

  // ── Context label (workspace / project name) ───────────────────

  const contextLabel = level === 'project' ? (
    <SidebarGroupLabel className="truncate" title={activeWorkspaceName ?? ''}>
      {activeWorkspaceName}
    </SidebarGroupLabel>
  ) : level === 'workspace' ? (
    <SidebarGroupLabel className="truncate" title={activeWorkspaceName ?? ''}>
      {activeWorkspaceName}
    </SidebarGroupLabel>
  ) : (
    <SidebarGroupLabel>Menu</SidebarGroupLabel>
  )

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center justify-between p-3">
        <Link
          to="/"
          className="group/logo flex items-center gap-2.5 transition-opacity hover:opacity-80 group-data-[collapsible=icon]:hidden"
          onClick={handleLogoClick}
        >
          <LinkrLogo size={28} animated />
          <span className="text-[15px] font-semibold text-sidebar-foreground">Linkr</span>
        </Link>
        <SidebarTrigger />
      </SidebarHeader>

      {backButton}

      <SidebarContent>
        <SidebarGroup>
          {contextLabel}
          <SidebarGroupContent>
            <SidebarMenu>
              {level === 'app' && appNavItems.map(renderAppItem)}
              {level === 'workspace' && renderSegmentNav(workspaceNavItems)}
              {level === 'project' && renderSegmentNav(projectNavItems)}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {level === 'app' && (
        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            {appBottomItems.map(renderAppItem)}
          </SidebarMenu>
        </SidebarFooter>
      )}

      {level === 'workspace' && (
        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            {workspaceBottomItems.map((item) => renderSegmentTopItem(item))}
          </SidebarMenu>
        </SidebarFooter>
      )}

      {level === 'project' && (
        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            {projectBottomItems.map((item) => renderSegmentTopItem(item))}
          </SidebarMenu>
        </SidebarFooter>
      )}

      <SidebarRail />
    </Sidebar>
  )
}
