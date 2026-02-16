import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { useAppStore } from '@/stores/app-store'
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
import { LinkRLogo } from '@/components/ui/linkr-logo'

interface NavItem {
  path: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  labelKey: string
  iconColor?: string
}

interface NavGroup {
  type: 'group'
  labelKey: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  iconColor?: string
  children: NavItem[]
  defaultOpen?: boolean
}

type NavEntry = NavItem | NavGroup

interface ProjectNavItem {
  segment: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  labelKey: string
  iconColor: string
}

interface ProjectNavGroup {
  type: 'group'
  labelKey: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  iconColor: string
  children: ProjectNavItem[]
  defaultOpen?: boolean
}

type ProjectNavEntry = ProjectNavItem | ProjectNavGroup

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'type' in entry && entry.type === 'group'
}

const appNavItems: NavEntry[] = [
  { path: '/', icon: Home, labelKey: 'nav.home', iconColor: 'text-blue-500' },
  { path: '/projects', icon: FolderOpen, labelKey: 'nav.projects', iconColor: 'text-amber-500' },
  { path: '/catalog', icon: Store, labelKey: 'nav.catalog', iconColor: 'text-violet-500' },
  { path: '/wiki', icon: BookOpen, labelKey: 'nav.wiki', iconColor: 'text-emerald-500' },
  { path: '/plugins', icon: Puzzle, labelKey: 'nav.plugins', iconColor: 'text-pink-500' },
  {
    type: 'group',
    labelKey: 'nav.warehouse',
    icon: Warehouse,
    iconColor: 'text-teal-500',
    defaultOpen: false,
    children: [
      { path: '/warehouse/databases', icon: Database, labelKey: 'app_warehouse.nav_databases', iconColor: 'text-teal-500' },
      { path: '/warehouse/schema-presets', icon: FileSpreadsheet, labelKey: 'app_warehouse.nav_schema_presets', iconColor: 'text-teal-500' },
      { path: '/warehouse/concept-mapping', icon: ArrowRightLeft, labelKey: 'app_warehouse.nav_concept_mapping', iconColor: 'text-teal-500' },
      { path: '/warehouse/etl', icon: Workflow, labelKey: 'app_warehouse.nav_etl', iconColor: 'text-teal-500' },
    ],
  },
  { path: '/versioning', icon: GitBranch, labelKey: 'nav.versioning', iconColor: 'text-orange-400' },
]

const appBottomItems: NavItem[] = [
  { path: '/settings', icon: Settings, labelKey: 'nav.settings', iconColor: 'text-slate-400' },
]

const projectNavItems: ProjectNavEntry[] = [
  { segment: 'summary', icon: LayoutDashboard, labelKey: 'project_nav.summary', iconColor: 'text-blue-500' },
  { segment: 'pipeline', icon: Workflow, labelKey: 'project_nav.pipeline', iconColor: 'text-orange-500' },
  { segment: 'ide', icon: Code, labelKey: 'project_nav.ide', iconColor: 'text-violet-500' },
  {
    type: 'group',
    labelKey: 'project_nav.data_warehouse',
    icon: Warehouse,
    iconColor: 'text-teal-500',
    defaultOpen: true,
    children: [
      { segment: 'warehouse/databases', icon: Database, labelKey: 'project_nav.databases', iconColor: 'text-teal-500' },
      { segment: 'warehouse/concepts', icon: BookOpen, labelKey: 'project_nav.concepts', iconColor: 'text-teal-500' },
      { segment: 'warehouse/data-quality', icon: ShieldCheck, labelKey: 'project_nav.data_quality', iconColor: 'text-teal-500' },
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
  { segment: 'settings', icon: Settings2, labelKey: 'project_nav.project_settings', iconColor: 'text-slate-400' },
]

function isGroup(entry: ProjectNavEntry): entry is ProjectNavGroup {
  return 'type' in entry && entry.type === 'group'
}

export function AppSidebar() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { activeProjectUid, closeProject } = useAppStore()
  const { state: sidebarState } = useSidebar()
  const isCollapsed = sidebarState === 'collapsed'

  const inProject = activeProjectUid !== null

  const handleCloseProject = () => {
    closeProject()
    navigate('/projects')
  }

  const renderProjectNavItem = (item: ProjectNavItem) => {
    const path = `/projects/${activeProjectUid}/${item.segment}`
    const isActive = location.pathname === path
    return (
      <SidebarMenuSubItem key={item.segment}>
        <SidebarMenuSubButton
          asChild
          isActive={isActive}
        >
          <Link to={path}>
            <item.icon className={isActive ? '' : item.iconColor} />
            <span>{t(item.labelKey)}</span>
          </Link>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    )
  }

  const renderProjectGroup = (entry: ProjectNavGroup) => {
    const isChildActive = entry.children.some(
      (child) => location.pathname === `/projects/${activeProjectUid}/${child.segment}`,
    )

    // When collapsed, show a dropdown menu from the icon
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
                const path = `/projects/${activeProjectUid}/${child.segment}`
                const isActive = location.pathname === path
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
              {entry.children.map((child) => renderProjectNavItem(child))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    )
  }

  const renderAppGroup = (entry: NavGroup) => {
    const isChildActive = entry.children.some(
      (child) => location.pathname === child.path,
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
                const isActive = location.pathname === child.path
                return (
                  <DropdownMenuItem
                    key={child.path}
                    className={isActive ? 'bg-accent' : ''}
                    onClick={() => navigate(child.path)}
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
              {entry.children.map((child) => {
                const isActive = location.pathname === child.path
                return (
                  <SidebarMenuSubItem key={child.path}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={isActive}
                    >
                      <Link to={child.path}>
                        <child.icon className={isActive ? '' : child.iconColor} />
                        <span>{t(child.labelKey)}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    )
  }

  const renderProjectTopLevelItem = (item: ProjectNavItem) => {
    const path = `/projects/${activeProjectUid}/${item.segment}`
    const isActive = location.pathname === path
    return (
      <SidebarMenuItem key={item.segment}>
        <SidebarMenuButton
          asChild
          isActive={isActive}
          tooltip={t(item.labelKey)}
        >
          <Link to={path}>
            <item.icon className={isActive ? '' : item.iconColor} />
            <span>{t(item.labelKey)}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center justify-between p-3">
        <Link
          to="/"
          className="group/logo flex items-center gap-2.5 transition-opacity hover:opacity-80 group-data-[collapsible=icon]:hidden"
          onClick={() => { if (inProject) { closeProject() } }}
        >
          <LinkRLogo size={28} animated />
          <span className="text-[15px] font-semibold text-sidebar-foreground">LinkR</span>
        </Link>
        <SidebarTrigger />
      </SidebarHeader>

      {inProject && (
        <div className="mx-2 mb-1 group-data-[collapsible=icon]:hidden">
          <button
            onClick={handleCloseProject}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ArrowLeft size={12} />
            {t('project_nav.back_to_projects')}
          </button>
        </div>
      )}

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            {inProject ? 'Navigation' : 'Menu'}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {inProject
                ? projectNavItems.map((entry) => {
                    if (isGroup(entry)) {
                      return renderProjectGroup(entry)
                    }
                    return renderProjectTopLevelItem(entry)
                  })
                : appNavItems.map((entry) => {
                    if (isNavGroup(entry)) {
                      return renderAppGroup(entry)
                    }
                    const isActive = entry.path === '/'
                      ? location.pathname === '/'
                      : location.pathname.startsWith(entry.path)
                    return (
                      <SidebarMenuItem key={entry.path}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          tooltip={t(entry.labelKey)}
                        >
                          <Link to={entry.path}>
                            <entry.icon className={isActive ? '' : entry.iconColor} />
                            <span>{t(entry.labelKey)}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {!inProject && (
        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            {appBottomItems.map((item) => {
              const isActive = location.pathname.startsWith(item.path)
              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={t(item.labelKey)}
                  >
                    <Link to={item.path}>
                      <item.icon className={isActive ? '' : item.iconColor} />
                      <span>{t(item.labelKey)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  )
}
