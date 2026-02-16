import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  FolderOpen,
  ArrowRight,
  BookOpen,
  Settings,
  Plus,
  Database,
  Store,
  GitBranch,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useAppStore } from '@/stores/app-store'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from '@/features/projects/ProjectSettingsPage'

const quickActions = [
  {
    icon: FolderOpen,
    labelKey: 'home.action_projects',
    descKey: 'home.action_projects_description',
    color: 'bg-blue-500/10 text-blue-600',
    path: '/projects',
  },
  {
    icon: Database,
    labelKey: 'home.action_databases',
    descKey: 'home.action_databases_description',
    color: 'bg-teal-500/10 text-teal-600',
    path: '/warehouse/databases',
  },
  {
    icon: Store,
    labelKey: 'home.action_catalog',
    descKey: 'home.action_catalog_description',
    color: 'bg-violet-500/10 text-violet-600',
    path: '/catalog',
  },
  {
    icon: BookOpen,
    labelKey: 'home.action_wiki',
    descKey: 'home.action_wiki_description',
    color: 'bg-amber-500/10 text-amber-600',
    path: '/wiki',
  },
  {
    icon: GitBranch,
    labelKey: 'home.action_versioning',
    descKey: 'home.action_versioning_description',
    color: 'bg-orange-500/10 text-orange-600',
    path: '/versioning',
  },
  {
    icon: Settings,
    labelKey: 'home.action_settings',
    descKey: 'home.action_settings_description',
    color: 'bg-slate-500/10 text-slate-600',
    path: '/settings',
  },
]

const MAX_RECENT = 4

export function HomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { _projectsRaw, projects, openProject } = useAppStore()

  const recentProjects = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_RECENT)

  const handleOpenProject = (uid: string, name: string) => {
    openProject(uid, name)
    navigate(`/projects/${uid}/summary`)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-8 py-12">
        {/* Hero */}
        <div className="text-center">
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-foreground">
            {t('home.hero_title')}{' '}
            <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
              {t('home.hero_title_highlight')}
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            {t('home.hero_description')}
          </p>
        </div>

        {/* Recent projects */}
        <div className="mt-12">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              {t('home.recent_projects')}
            </h2>
            {projects.length > 0 && (
              <Button
                variant="link"
                size="sm"
                onClick={() => navigate('/projects')}
                className="h-auto gap-1 p-0 text-xs"
              >
                {t('home.view_all_projects')}
                <ArrowRight size={12} />
              </Button>
            )}
          </div>

          {recentProjects.length > 0 ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {recentProjects.map((project) => {
                const raw = _projectsRaw.find((p) => p.uid === project.uid)
                const badges = raw?.badges ?? []
                const status = raw?.status ?? 'active'
                return (
                  <Card
                    key={project.uid}
                    className="cursor-pointer transition-colors hover:bg-accent"
                    onClick={() => handleOpenProject(project.uid, project.name)}
                  >
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                            <FolderOpen size={16} className="text-primary" />
                          </div>
                          <span className="truncate text-sm font-medium text-card-foreground">{project.name}</span>
                        </div>
                        <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusClasses(status)}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
                          {t(`project_settings.status_${status}`)}
                        </span>
                      </div>
                      {project.description && (
                        <p className="mt-2 truncate text-xs text-muted-foreground" title={project.description}>
                          {project.description}
                        </p>
                      )}
                      {badges.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {badges.map((badge) => (
                            <span
                              key={badge.id}
                              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getBadgeClasses(badge.color)}`}
                              style={getBadgeStyle(badge.color)}
                            >
                              {badge.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card className="mt-3">
              <CardContent className="flex flex-col items-center justify-center py-10">
                <FolderOpen
                  size={32}
                  className="text-muted-foreground"
                />
                <p className="mt-3 text-sm font-medium text-muted-foreground">
                  {t('home.no_recent_projects')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('home.no_recent_projects_description')}
                </p>
                <Button onClick={() => navigate('/projects?create=true')} className="mt-4 gap-2">
                  <Plus size={16} />
                  {t('home.create_project')}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Quick actions */}
        <div className="mt-12">
          <h2 className="text-sm font-semibold text-foreground">
            {t('home.quick_actions')}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {quickActions.map((action) => (
              <QuickAction
                key={action.labelKey}
                icon={action.icon}
                label={t(action.labelKey)}
                description={t(action.descKey)}
                color={action.color}
                onClick={() => navigate(action.path)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function QuickAction({
  icon: Icon,
  label,
  description,
  color,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  description: string
  color: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:bg-accent hover:shadow-md"
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-110 ${color}`}>
        <Icon size={16} />
      </div>
      <div>
        <p className="text-[13px] font-medium text-card-foreground">
          {label}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {description}
        </p>
      </div>
    </button>
  )
}
