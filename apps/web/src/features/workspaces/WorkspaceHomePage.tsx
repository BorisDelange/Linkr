import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import {
  FolderOpen,
  ArrowRight,
  ArrowRightLeft,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from '@/features/projects/ProjectSettingsPage'
import { ReadmeEditor } from '@/components/editor/ReadmeEditor'

const MAX_RECENT = 4

export function WorkspaceHomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useParams()
  const { _workspacesRaw, updateWorkspaceReadme } = useWorkspaceStore()
  const { _projectsRaw, getWorkspaceProjects, openProject, language } = useAppStore()

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
      icon: ArrowRightLeft,
      labelKey: 'workspaces.action_concept_mapping',
      descKey: 'workspaces.action_concept_mapping_description',
      color: 'bg-violet-500/10 text-violet-600',
      path: `warehouse/concept-mapping`,
    },
    {
      icon: GitBranch,
      labelKey: 'workspaces.action_versioning',
      descKey: 'workspaces.action_versioning_description',
      color: 'bg-orange-500/10 text-orange-600',
      path: `versioning`,
    },
  ]

  const { getOrganization } = useOrganizationStore()
  const linkedOrg = workspace?.organizationId ? getOrganization(workspace.organizationId) : null
  const org = linkedOrg ?? (workspace?.organization?.name ? workspace?.organization : null)
  const wsDescription = workspace?.description[language] ?? workspace?.description['en'] ?? ''
  const wsName = workspace?.name[language] ?? workspace?.name['en'] ?? ''

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Workspace header */}
      <div className="shrink-0 px-8 pt-8 pb-2">
        <div className="mx-auto max-w-4xl">
          <Card>
            <CardContent className="flex gap-0 p-0">
              {/* Workspace (left) */}
              <div className="min-w-0 flex-1 p-5">
                <h2 className="text-lg font-semibold text-card-foreground leading-tight">{wsName}</h2>
                {wsDescription && (
                  <p className="mt-1.5 text-sm text-muted-foreground">{wsDescription}</p>
                )}
              </div>
              {/* Organization (right) */}
              {org && org.name && (
                <div className="flex max-w-[280px] shrink-0 items-center border-l px-5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Building2 size={18} className="text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="truncate text-sm font-medium text-card-foreground">{org.name}</p>
                          </TooltipTrigger>
                          <TooltipContent>{org.name}</TooltipContent>
                        </Tooltip>
                        {org.type && (
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {org.type === 'other' && org.customType ? org.customType : t(`workspaces.org_type_${org.type}`)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {(org.location || org.country) && (
                          <span className="flex items-center gap-1">
                            <MapPin size={10} />
                            {[org.location, org.country].filter(Boolean).join(', ')}
                          </span>
                        )}
                        {org.website && (
                          <span className="flex items-center gap-1"><Globe size={10} />{org.website}</span>
                        )}
                        {org.email && (
                          <span className="flex items-center gap-1"><Mail size={10} />{org.email}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col px-8 pb-6">
        <div className="mx-auto w-full max-w-4xl">
          <TabsList variant="line" className="shrink-0">
            <TabsTrigger value="overview">{t('summary.tab_overview')}</TabsTrigger>
            <TabsTrigger value="readme">{t('summary.tab_readme')}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl py-4">
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
        </TabsContent>

        <TabsContent value="readme" className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto h-full max-w-4xl">
            {wsUid && (
              <ReadmeEditor
                readme={workspace?.readme ?? ''}
                onSave={(content) => updateWorkspaceReadme(wsUid, content)}
              />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
