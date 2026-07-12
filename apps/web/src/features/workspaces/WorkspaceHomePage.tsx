import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Link, useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { localized } from '@/lib/localized'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import { useVisitStore, sortByRecency } from '@/stores/visit-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWikiStore } from '@/stores/wiki-store'
import type { LocalizedString, ProjectStatus } from '@/types'
import {
  FolderOpen,
  ArrowRight,
  ArrowUpRight,
  ArrowRightLeft,
  Database,
  BookOpen,
  FileText,
  Building2,
  Globe,
  Mail,
  MapPin,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getStatusClasses, getStatusDotClass } from '@/features/projects/ProjectSettingsPage'
import { ReadmeEditor, remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { Paperclip } from 'lucide-react'
import { useWorkspaceReadmeAttachments } from '@/hooks/use-workspace-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { ReadmeAttachmentsDialog } from '@/features/projects/summary/ReadmeAttachmentsDialog'

const MAX_RECENT = 2

export function WorkspaceHomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const canWriteSummary = useMyWorkspaceRole(wsUid).can('workspace-summary:write')
  const { _workspacesRaw, updateWorkspaceReadme } = useWorkspaceStore()
  const { _projectsRaw, getWorkspaceProjects, openProject, language } = useAppStore()

  const [tab, setTab] = useState('overview')
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const { attachments, uploadAttachment, deleteAttachment, resolveAttachmentUrls } =
    useWorkspaceReadmeAttachments(wsUid ?? '')

  const workspace = _workspacesRaw.find((ws) => ws.id === wsUid)
  const projects = wsUid ? getWorkspaceProjects(wsUid) : []

  // Subscribe so the recent lists re-sort when this user's visit history changes.
  const lastVisited = useVisitStore((s) => s.lastVisited)

  const recentProjects = useMemo(
    () => sortByRecency(projects, 'project', (p) => p.uid, (p) => p.updatedAt).slice(0, MAX_RECENT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, lastVisited],
  )

  // Populate the stores so the overview's counts are accurate even when landing here directly.
  const loadDataSources = useDataSourceStore((s) => s.loadDataSources)
  const loadMappingProjects = useConceptMappingStore((s) => s.loadMappingProjects)
  const loadPages = useWikiStore((s) => s.loadPages)
  useEffect(() => {
    loadDataSources()
    loadMappingProjects()
    if (wsUid) loadPages(wsUid)
  }, [wsUid, loadDataSources, loadMappingProjects, loadPages])

  const dataSources = useDataSourceStore((s) => s.dataSources)
  const mappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const wikiPages = useWikiStore((s) => s.pages)

  const wsDataSources = dataSources.filter((d) => d.workspaceId === wsUid && !d.isVocabularyReference)
  const wsMappingProjects = mappingProjects.filter((m) => m.workspaceId === wsUid)
  const wsWikiPages = wikiPages.filter((p) => p.workspaceId === wsUid)

  const recentMappingProjects = useMemo(
    () => sortByRecency(wsMappingProjects, 'mapping-project', (m) => m.id, (m) => m.updatedAt).slice(0, MAX_RECENT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wsMappingProjects, lastVisited],
  )

  const handleOpenProject = (uid: string, name: string) => {
    openProject(uid, name)
    navigate(paths.projectSummary(wsUid ?? '', uid))
  }

  const { getOrganization } = useOrganizationStore()
  const linkedOrg = workspace?.organizationId ? getOrganization(workspace.organizationId) : null
  const org = linkedOrg ?? (workspace?.organization?.name ? workspace?.organization : null)
  const wsDescription = localized(workspace?.description, language)
  const wsName = localized(workspace?.name, language)
  const readme = localized(workspace?.readme, language)

  const projectsPath = `/workspaces/${wsUid}/projects`
  const databasesPath = `/workspaces/${wsUid}/warehouse/databases`
  const mappingPath = `/workspaces/${wsUid}/warehouse/concept-mapping`
  const wikiPath = `/workspaces/${wsUid}/wiki`

  const handleOpenMappingProject = (id: string) => {
    navigate(`/workspaces/${wsUid}/warehouse/concept-mapping/${id}`)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Workspace header */}
      <div className="shrink-0 px-6 pt-6 pb-2">
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
                          <p className="truncate text-sm font-medium text-card-foreground">{localized(org.name, language)}</p>
                        </TooltipTrigger>
                        <TooltipContent>{localized(org.name, language)}</TooltipContent>
                      </Tooltip>
                      {org.type && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {org.type === 'other' && org.customType ? localized(org.customType, language) : t(`workspaces.org_type_${org.type}`)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {(org.location || org.country) && (
                        <span className="flex items-center gap-1">
                          <MapPin size={10} />
                          {[localized(org.location, language), localized(org.country, language)].filter(Boolean).join(', ')}
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

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col px-6 pb-6">
        <TabsList variant="line" className="shrink-0">
          <TabsTrigger value="overview">{t('summary.tab_overview')}</TabsTrigger>
          <TabsTrigger value="readme">{t('summary.tab_readme')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-hidden">
          <OverviewTab
            readme={readme}
            resolveUrls={resolveAttachmentUrls}
            onViewReadme={() => setTab('readme')}
            recentProjects={recentProjects}
            totalProjects={projects.length}
            projectsRaw={_projectsRaw}
            onOpenProject={handleOpenProject}
            recentMappingProjects={recentMappingProjects}
            totalMappingProjects={wsMappingProjects.length}
            onOpenMappingProject={handleOpenMappingProject}
            language={language}
            projectsPath={projectsPath}
            databasesPath={databasesPath}
            mappingPath={mappingPath}
            wikiPath={wikiPath}
            counts={{
              projects: projects.length,
              databases: wsDataSources.length,
              mappingProjects: wsMappingProjects.length,
              wikiPages: wsWikiPages.length,
            }}
          />
        </TabsContent>

        <TabsContent value="readme" className="min-h-0 flex-1 overflow-hidden">
          {wsUid && (
            <ReadmeEditor
              readme={readme}
              onSave={(content) => updateWorkspaceReadme(wsUid, content)}
              resolveUrls={resolveAttachmentUrls}
              canEdit={canWriteSummary}
              headerActions={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2 text-xs text-muted-foreground"
                  disabled={!canWriteSummary}
                  onClick={() => setAttachmentsOpen(true)}
                >
                  <Paperclip size={12} />
                  {t('summary.attachments')}
                </Button>
              }
            />
          )}
        </TabsContent>
      </Tabs>

      <ReadmeAttachmentsDialog
        open={attachmentsOpen}
        onOpenChange={setAttachmentsOpen}
        attachments={attachments}
        onUpload={async (file) => { await uploadAttachment(file) }}
        onDelete={async (id) => { await deleteAttachment(id) }}
      />
    </div>
  )
}

interface RecentProject {
  uid: string
  name: string
  updatedAt: string
}

interface RecentMappingProject {
  id: string
  name: LocalizedString
  status?: string
}

function OverviewTab({
  readme,
  resolveUrls,
  onViewReadme,
  recentProjects,
  totalProjects,
  projectsRaw,
  onOpenProject,
  recentMappingProjects,
  totalMappingProjects,
  onOpenMappingProject,
  language,
  projectsPath,
  databasesPath,
  mappingPath,
  wikiPath,
  counts,
}: {
  readme: string
  resolveUrls: (md: string) => string
  onViewReadme: () => void
  recentProjects: RecentProject[]
  totalProjects: number
  projectsRaw: { uid: string; status?: ProjectStatus }[]
  onOpenProject: (uid: string, name: string) => void
  recentMappingProjects: RecentMappingProject[]
  totalMappingProjects: number
  onOpenMappingProject: (id: string) => void
  language: string
  projectsPath: string
  databasesPath: string
  mappingPath: string
  wikiPath: string
  counts: {
    projects: number
    databases: number
    mappingProjects: number
    wikiPages: number
  }
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden pt-4">
      {/* Readme + Recent entities — top half */}
      <div className="grid min-h-0 basis-1/2 grid-cols-1 gap-4 lg:grid-cols-2">
        <ReadmePreview readme={readme} resolveUrls={resolveUrls} onViewFull={onViewReadme} />
        <RecentEntitiesCard
          recentProjects={recentProjects}
          totalProjects={totalProjects}
          projectsRaw={projectsRaw}
          onOpenProject={onOpenProject}
          projectsPath={projectsPath}
          recentMappingProjects={recentMappingProjects}
          totalMappingProjects={totalMappingProjects}
          onOpenMappingProject={onOpenMappingProject}
          mappingPath={mappingPath}
          language={language}
        />
      </div>

      {/* Stat cards — fixed-height bottom row */}
      <div className="grid shrink-0 grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={<FolderOpen size={18} />}
            iconBg="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            value={counts.projects}
            label={t('workspaces.stat_projects')}
            to={projectsPath}
          />
          <StatCard
            icon={<Database size={18} />}
            iconBg="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
            value={counts.databases}
            label={t('workspaces.stat_databases')}
            to={databasesPath}
          />
          <StatCard
            icon={<ArrowRightLeft size={18} />}
            iconBg="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
            value={counts.mappingProjects}
            label={t('workspaces.stat_mapping_projects')}
            to={mappingPath}
          />
          <StatCard
            icon={<BookOpen size={18} />}
            iconBg="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            value={counts.wikiPages}
            label={t('workspaces.stat_wiki_pages')}
            to={wikiPath}
          />
      </div>
    </div>
  )
}

function ReadmePreview({ readme, resolveUrls, onViewFull }: { readme: string; resolveUrls: (md: string) => string; onViewFull: () => void }) {
  const { t } = useTranslation()
  const resolved = resolveUrls(readme)
  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('summary.readme')}</h3>
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onViewFull}>
          {t('summary.view_full')}
          <ArrowUpRight size={12} />
        </Button>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {readme.trim() ? (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:!mt-0">
            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
              {resolved}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('workspaces.readme_empty')}</p>
        )}
      </div>
    </div>
  )
}

function RecentEntitiesCard({
  recentProjects,
  totalProjects,
  projectsRaw,
  onOpenProject,
  projectsPath,
  recentMappingProjects,
  totalMappingProjects,
  onOpenMappingProject,
  mappingPath,
  language,
}: {
  recentProjects: RecentProject[]
  totalProjects: number
  projectsRaw: { uid: string; status?: ProjectStatus }[]
  onOpenProject: (uid: string, name: string) => void
  projectsPath: string
  recentMappingProjects: RecentMappingProject[]
  totalMappingProjects: number
  onOpenMappingProject: (id: string) => void
  mappingPath: string
  language: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto rounded-xl border bg-card p-5 shadow-sm">
      {/* Recent projects */}
      <section className="shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderOpen size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t('home.recent_projects')}</h3>
          </div>
          {totalProjects > 0 && (
            <Link
              to={projectsPath}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t('home.view_all_projects')}
              <ArrowRight size={10} />
            </Link>
          )}
        </div>
        <div className="mt-2 space-y-1">
          {recentProjects.length > 0 ? (
            recentProjects.map((project) => {
              const status = projectsRaw.find((p) => p.uid === project.uid)?.status ?? 'active'
              return (
                <button
                  key={project.uid}
                  onClick={() => onOpenProject(project.uid, project.name)}
                  className="flex w-full items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <FolderOpen size={13} className="shrink-0 text-primary" />
                  <span className="flex-1 truncate text-xs">{project.name}</span>
                  <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${getStatusClasses(status)}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
                    {t(`project_settings.status_${status}`)}
                  </span>
                </button>
              )
            })
          ) : (
            <p className="text-xs text-muted-foreground">{t('home.no_recent_projects')}</p>
          )}
        </div>
      </section>

      {/* Recent mapping projects */}
      <section className="shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowRightLeft size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t('workspaces.recent_mapping_projects')}</h3>
          </div>
          {totalMappingProjects > 0 && (
            <Link
              to={mappingPath}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t('home.view_all_projects')}
              <ArrowRight size={10} />
            </Link>
          )}
        </div>
        <div className="mt-2 space-y-1">
          {recentMappingProjects.length > 0 ? (
            recentMappingProjects.map((mp) => (
              <button
                key={mp.id}
                onClick={() => onOpenMappingProject(mp.id)}
                className="flex w-full items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <ArrowRightLeft size={13} className="shrink-0 text-primary" />
                <span className="flex-1 truncate text-xs">{localized(mp.name, language)}</span>
                {mp.status && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t(`concept_mapping.project_status_${mp.status}`)}
                  </span>
                )}
              </button>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">{t('home.no_recent_projects')}</p>
          )}
        </div>
      </section>
    </div>
  )
}

function StatCard({
  icon,
  iconBg,
  value,
  label,
  to,
}: {
  icon: React.ReactNode
  iconBg: string
  value: number
  label: string
  to?: string
}) {
  const content = (
    <div className="flex items-center gap-3">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconBg}`}>
        {icon}
      </div>
      <div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
  const className = 'rounded-xl border bg-card p-4 shadow-sm'
  if (to) {
    return (
      <Link to={to} className={`${className} block transition-colors hover:bg-accent/50`}>
        {content}
      </Link>
    )
  }
  return <div className={className}>{content}</div>
}
