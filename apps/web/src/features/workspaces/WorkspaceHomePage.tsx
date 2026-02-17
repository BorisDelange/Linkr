import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import {
  FolderOpen,
  ArrowRight,
  BookOpen,
  Database,
  GitBranch,
  Puzzle,
  Plus,
  Building2,
  Globe,
  Mail,
  MapPin,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from '@/features/projects/ProjectSettingsPage'

const MAX_RECENT = 4

export function WorkspaceHomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useParams()
  const { _workspacesRaw } = useWorkspaceStore()
  const { _projectsRaw, getWorkspaceProjects, openProject } = useAppStore()

  const workspace = _workspacesRaw.find((ws) => ws.id === wsUid)
  const projects = wsUid ? getWorkspaceProjects(wsUid) : []

  const recentProjects = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_RECENT)

  const handleOpenProject = (uid: string, name: string) => {
    openProject(uid, name)
    navigate(`/workspaces/${wsUid}/projects/${uid}/summary`)
  }

  const quickActions = [
    {
      icon: FolderOpen,
      labelKey: 'workspaces.action_projects',
      descKey: 'workspaces.action_projects_description',
      color: 'bg-amber-500/10 text-amber-600',
      path: `projects`,
    },
    {
      icon: BookOpen,
      labelKey: 'workspaces.action_wiki',
      descKey: 'workspaces.action_wiki_description',
      color: 'bg-emerald-500/10 text-emerald-600',
      path: `wiki`,
    },
    {
      icon: Puzzle,
      labelKey: 'workspaces.action_plugins',
      descKey: 'workspaces.action_plugins_description',
      color: 'bg-pink-500/10 text-pink-600',
      path: `plugins`,
    },
    {
      icon: Database,
      labelKey: 'workspaces.action_databases',
      descKey: 'workspaces.action_databases_description',
      color: 'bg-teal-500/10 text-teal-600',
      path: `warehouse/databases`,
    },
    {
      icon: GitBranch,
      labelKey: 'workspaces.action_versioning',
      descKey: 'workspaces.action_versioning_description',
      color: 'bg-orange-500/10 text-orange-600',
      path: `versioning`,
    },
  ]

  const org = workspace?.organization

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-8 py-12">
        {/* Organization info card */}
        {org && org.name && (
          <Card className="mb-8">
            <CardContent className="flex items-start gap-4 p-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Building2 size={20} className="text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-card-foreground">{org.name}</p>
                  {org.type && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {t(`workspaces.org_type_${org.type}`)}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {(org.location || org.country) && (
                    <span className="flex items-center gap-1">
                      <MapPin size={12} />
                      {[org.location, org.country].filter(Boolean).join(', ')}
                    </span>
                  )}
                  {org.website && (
                    <span className="flex items-center gap-1"><Globe size={12} />{org.website}</span>
                  )}
                  {org.email && (
                    <span className="flex items-center gap-1"><Mail size={12} />{org.email}</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent projects */}
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              {t('home.recent_projects')}
            </h2>
            {projects.length > 0 && (
              <Button
                variant="link"
                size="sm"
                onClick={() => navigate(`/workspaces/${wsUid}/projects`)}
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
                <FolderOpen size={32} className="text-muted-foreground" />
                <p className="mt-3 text-sm font-medium text-muted-foreground">
                  {t('home.no_recent_projects')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('home.no_recent_projects_description')}
                </p>
                <Button onClick={() => navigate(`/workspaces/${wsUid}/projects?create=true`)} className="mt-4 gap-2">
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
              <button
                key={action.labelKey}
                onClick={() => navigate(`/workspaces/${wsUid}/${action.path}`)}
                className="group flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:bg-accent hover:shadow-md"
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-110 ${action.color}`}>
                  <action.icon size={16} />
                </div>
                <div>
                  <p className="text-[13px] font-medium text-card-foreground">
                    {t(action.labelKey)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t(action.descKey)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
