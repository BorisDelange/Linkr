import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Link, useNavigate, useSearchParams } from 'react-router'
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
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useEtlStore } from '@/stores/etl-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDqStore } from '@/stores/dq-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { ENTITY_COLORS, type EntityColorKey } from '@/lib/entity-colors'
import {
  FolderOpen,
  ArrowRight,
  ArrowUpRight,
  ArrowRightLeft,
  Database,
  BookOpen,
  FileText,
  FileSpreadsheet,
  Puzzle,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  Building2,
  Globe,
  Mail,
  MapPin,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getStatusClasses, getStatusDotClass } from '@/features/projects/ProjectSettingsPage'
import { ReadmeEditor, remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { LicenseEditor } from '@/components/editor/LicenseEditor'
import { Paperclip } from 'lucide-react'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { AttachmentsDialog } from '@/components/editor/AttachmentsDialog'

const MAX_RECENT = 3

/** Newest-updated first, for the kinds visit history doesn't track (see sortByRecency). */
function byUpdatedAt<T extends { updatedAt?: string; createdAt?: string }>(items: T[]): T[] {
  const stamp = (i: T) => new Date(i.updatedAt ?? i.createdAt ?? 0).getTime()
  return [...items].sort((a, b) => stamp(b) - stamp(a))
}

export function WorkspaceHomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const canWriteSummary = useMyWorkspaceRole(wsUid).can('workspace-summary:write')
  const { _workspacesRaw, updateWorkspaceReadme, updateWorkspaceLicense } = useWorkspaceStore()
  const { _projectsRaw, getWorkspaceProjects, openProject, language } = useAppStore()

  // URL-synced like the project summary's tabs, so a card's license chip can link
  // straight here and the tab survives a reload.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') ?? 'overview'
  const setTab = (value: string) => {
    setSearchParams((prev) => {
      if (value === 'overview') prev.delete('tab')
      else prev.set('tab', value)
      return prev
    })
  }
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const { attachments, uploadAttachment, deleteAttachment, resolveAttachmentUrls } =
    useReadmeAttachments('workspace', wsUid ?? '')

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
  const loadCollections = useSqlScriptsStore((s) => s.loadCollections)
  const loadEtlPipelines = useEtlStore((s) => s.loadEtlPipelines)
  const loadCatalogs = useCatalogStore((s) => s.loadCatalogs)
  const loadDqRuleSets = useDqStore((s) => s.loadDqRuleSets)
  const loadPresets = useSchemaPresetStore((s) => s.loadPresets)
  const refreshPluginList = usePluginEditorStore((s) => s.refreshPluginList)
  useEffect(() => {
    loadDataSources()
    loadMappingProjects()
    loadCollections()
    loadEtlPipelines()
    loadCatalogs()
    loadDqRuleSets()
    void refreshPluginList()
    if (wsUid) {
      loadPages(wsUid)
      loadPresets(wsUid)
    }
  }, [wsUid, loadDataSources, loadMappingProjects, loadPages, loadCollections, loadEtlPipelines, loadCatalogs, loadDqRuleSets, loadPresets, refreshPluginList])

  const dataSources = useDataSourceStore((s) => s.dataSources)
  const mappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const wikiPages = useWikiStore((s) => s.pages)
  const sqlCollections = useSqlScriptsStore((s) => s.collections)
  const etlPipelines = useEtlStore((s) => s.etlPipelines)
  const dataCatalogs = useCatalogStore((s) => s.catalogs)
  const dqRuleSets = useDqStore((s) => s.dqRuleSets)
  const schemaPresets = useSchemaPresetStore((s) => s.presets)
  // Already scoped to the active workspace by the store — no workspaceId on the rows.
  const plugins = usePluginEditorStore((s) => s.pluginList)

  const wsDataSources = dataSources.filter((d) => d.workspaceId === wsUid && !d.isVocabularyReference)
  const wsMappingProjects = mappingProjects.filter((m) => m.workspaceId === wsUid)
  const wsWikiPages = wikiPages.filter((p) => p.workspaceId === wsUid)
  const wsSqlCollections = sqlCollections.filter((c) => c.workspaceId === wsUid)
  const wsEtlPipelines = etlPipelines.filter((p) => p.workspaceId === wsUid)
  const wsDataCatalogs = dataCatalogs.filter((c) => c.workspaceId === wsUid)
  const wsDqRuleSets = dqRuleSets.filter((r) => r.workspaceId === wsUid)
  const wsSchemaPresets = schemaPresets.filter((p) => p.workspaceId === wsUid)

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

  const projectsPath = paths.projects(wsUid ?? '')
  const databasesPath = paths.warehouseDatabases(wsUid ?? '')
  const mappingPath = paths.warehouseConceptMapping(wsUid ?? '')
  const wikiPath = paths.wiki(wsUid ?? '')

  const handleOpenMappingProject = (id: string) => {
    navigate(paths.warehouseConceptMappingProject(wsUid ?? '', id))
  }

  const ws = wsUid ?? ''
  // Every entity kind a workspace holds, in sidebar order, so the card mirrors the
  // nav rather than inventing its own ranking. Hue and icon come from the same
  // ENTITY_COLORS the sidebar reads.
  const recentGroups: RecentGroup[] = [
    {
      key: 'project',
      icon: FolderOpen,
      titleKey: 'home.recent_projects',
      listPath: projectsPath,
      total: projects.length,
      items: recentProjects.map((p) => {
        const status = _projectsRaw.find((r) => r.uid === p.uid)?.status ?? 'active'
        return {
          id: p.uid,
          name: p.name,
          badge: {
            label: t(`project_settings.status_${status}`),
            className: getStatusClasses(status),
            dotClass: getStatusDotClass(status),
          },
          onOpen: () => handleOpenProject(p.uid, p.name),
        }
      }),
    },
    {
      key: 'wiki-page',
      icon: BookOpen,
      titleKey: 'workspace_nav.wiki',
      listPath: wikiPath,
      total: wsWikiPages.length,
      items: byUpdatedAt(wsWikiPages).slice(0, MAX_RECENT).map((p) => ({
        id: p.id,
        name: localized(p.title, language),
        to: wikiPath,
      })),
    },
    {
      key: 'plugin',
      icon: Puzzle,
      titleKey: 'workspace_nav.plugins',
      listPath: paths.plugins(ws),
      total: plugins.length,
      items: byUpdatedAt(plugins).slice(0, MAX_RECENT).map((p) => ({
        id: p.id,
        name: localized(p.manifest.name, language),
        to: paths.plugins(ws),
      })),
    },
    {
      key: 'schema-preset',
      icon: FileSpreadsheet,
      titleKey: 'app_warehouse.nav_schemas',
      listPath: paths.warehouseSchemas(ws),
      total: wsSchemaPresets.length,
      items: byUpdatedAt(wsSchemaPresets).slice(0, MAX_RECENT).map((p) => ({
        id: p.id,
        // A preset carries no `name` — its label lives on the mapping.
        name: localized(p.mapping?.presetLabel, language) || p.id,
        to: paths.warehouseSchemas(ws),
      })),
    },
    {
      key: 'database',
      icon: Database,
      titleKey: 'app_warehouse.nav_databases',
      listPath: databasesPath,
      total: wsDataSources.length,
      items: byUpdatedAt(wsDataSources).slice(0, MAX_RECENT).map((d) => ({
        id: d.id,
        name: localized(d.name, language),
        to: paths.warehouseDatabase(ws, d.id),
      })),
    },
    {
      key: 'mapping-project',
      icon: ArrowRightLeft,
      titleKey: 'workspaces.recent_mapping_projects',
      listPath: mappingPath,
      total: wsMappingProjects.length,
      items: recentMappingProjects.map((mp) => ({
        id: mp.id,
        name: localized(mp.name, language),
        badge: mp.status ? { label: t(`concept_mapping.project_status_${mp.status}`) } : undefined,
        onOpen: () => handleOpenMappingProject(mp.id),
      })),
    },
    {
      key: 'sql-collection',
      icon: SquareTerminal,
      titleKey: 'app_warehouse.nav_sql_scripts',
      listPath: paths.warehouseSqlScripts(ws),
      total: wsSqlCollections.length,
      items: byUpdatedAt(wsSqlCollections).slice(0, MAX_RECENT).map((c) => ({
        id: c.id,
        name: localized(c.name, language),
        to: paths.warehouseSqlCollection(ws, c.id),
      })),
    },
    {
      key: 'dq-rule-set',
      icon: ShieldCheck,
      titleKey: 'app_warehouse.nav_data_quality',
      listPath: paths.warehouseDataQuality(ws),
      total: wsDqRuleSets.length,
      items: byUpdatedAt(wsDqRuleSets).slice(0, MAX_RECENT).map((r) => ({
        id: r.id,
        name: localized(r.name, language),
        to: paths.warehouseDqRuleSet(ws, r.id),
      })),
    },
    {
      key: 'data-catalog',
      icon: BookOpen,
      titleKey: 'app_warehouse.nav_catalog',
      listPath: paths.warehouseDataCatalogs(ws),
      total: wsDataCatalogs.length,
      items: byUpdatedAt(wsDataCatalogs).slice(0, MAX_RECENT).map((c) => ({
        id: c.id,
        name: localized(c.name, language),
        to: paths.warehouseDataCatalog(ws, c.id),
      })),
    },
    {
      key: 'etl-pipeline',
      icon: Workflow,
      titleKey: 'app_warehouse.nav_etl',
      listPath: paths.warehouseEtl(ws),
      total: wsEtlPipelines.length,
      items: byUpdatedAt(wsEtlPipelines).slice(0, MAX_RECENT).map((p) => ({
        id: p.id,
        name: localized(p.name, language),
        to: paths.warehouseEtlPipeline(ws, p.id),
      })),
    },
  ]

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
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col px-6 pb-3">
        <TabsList variant="line" className="shrink-0">
          <TabsTrigger value="overview">{t('summary.tab_overview')}</TabsTrigger>
          <TabsTrigger value="readme">{t('summary.tab_readme')}</TabsTrigger>
          <TabsTrigger value="license">{t('summary.tab_license')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-hidden">
          <OverviewTab
            readme={readme}
            resolveUrls={resolveAttachmentUrls}
            onViewReadme={() => setTab('readme')}
            recentGroups={recentGroups}
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

        <TabsContent value="license" className="min-h-0 flex-1 overflow-hidden">
          {wsUid && (
            <LicenseEditor
              license={workspace?.license ?? null}
              onSave={(license) => updateWorkspaceLicense(wsUid, license)}
              copyrightHolder={org?.name ? localized(org.name, language) : undefined}
              canEdit={canWriteSummary}
            />
          )}
        </TabsContent>
      </Tabs>

      <AttachmentsDialog
        open={attachmentsOpen}
        onOpenChange={setAttachmentsOpen}
        attachments={attachments}
        onUpload={async (file) => { await uploadAttachment(file) }}
        onDelete={async (id) => { await deleteAttachment(id) }}
      />
    </div>
  )
}

function OverviewTab({
  readme,
  resolveUrls,
  onViewReadme,
  recentGroups,
  projectsPath,
  databasesPath,
  mappingPath,
  wikiPath,
  counts,
}: {
  readme: string
  resolveUrls: (md: string) => string
  onViewReadme: () => void
  recentGroups: RecentGroup[]
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
      {/* Readme + Recent entities — fill all remaining vertical space above the stat cards */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <ReadmePreview readme={readme} resolveUrls={resolveUrls} onViewFull={onViewReadme} />
        <RecentEntitiesCard groups={recentGroups} />
      </div>

      {/* Stat cards — fixed-height bottom row. Hues come from ENTITY_COLORS so a
          count reads as the same entity its sidebar item and list rows do. */}
      <div className="grid shrink-0 grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={<FolderOpen size={18} />}
            iconBg={`${ENTITY_COLORS.project.bg} ${ENTITY_COLORS.project.icon}`}
            value={counts.projects}
            label={t('workspaces.stat_projects', { count: counts.projects })}
            to={projectsPath}
          />
          <StatCard
            icon={<Database size={18} />}
            iconBg={`${ENTITY_COLORS.database.bg} ${ENTITY_COLORS.database.icon}`}
            value={counts.databases}
            label={t('workspaces.stat_databases', { count: counts.databases })}
            to={databasesPath}
          />
          <StatCard
            icon={<ArrowRightLeft size={18} />}
            iconBg={`${ENTITY_COLORS['mapping-project'].bg} ${ENTITY_COLORS['mapping-project'].icon}`}
            value={counts.mappingProjects}
            label={t('workspaces.stat_mapping_projects', { count: counts.mappingProjects })}
            to={mappingPath}
          />
          <StatCard
            icon={<BookOpen size={18} />}
            iconBg={`${ENTITY_COLORS['wiki-page'].bg} ${ENTITY_COLORS['wiki-page'].icon}`}
            value={counts.wikiPages}
            label={t('workspaces.stat_wiki_pages', { count: counts.wikiPages })}
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

/** One entity kind's section in the overview card. */
interface RecentGroup {
  key: EntityColorKey
  icon: LucideIcon
  titleKey: string
  listPath: string
  total: number
  items: RecentRow[]
}

/** One row, normalised across entity kinds (name and id are read differently per kind). */
interface RecentRow {
  id: string
  name: string
  /** Rendered right-aligned: a project's status pill, a mapping project's status, … */
  badge?: { label: string; className?: string; dotClass?: string }
  onOpen?: () => void
  to?: string
}

function RecentEntitiesCard({ groups }: { groups: RecentGroup[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto rounded-xl border bg-card p-5 shadow-sm">
      {groups.map((group) => {
        const hue = ENTITY_COLORS[group.key]
        const Icon = group.icon
        return (
          <section key={group.key} className="shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon size={14} className={hue.icon} />
                <h3 className="text-sm font-semibold">{t(group.titleKey)}</h3>
                <span className="text-[10px] tabular-nums text-muted-foreground">{group.total}</span>
              </div>
              {group.total > 0 && (
                <Link
                  to={group.listPath}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('home.view_all_projects')}
                  <ArrowRight size={10} />
                </Link>
              )}
            </div>
            <div className="mt-2 space-y-1">
              {group.items.length > 0 ? (
                group.items.map((row) => {
                  const content = (
                    <>
                      <Icon size={13} className={`shrink-0 ${hue.icon}`} />
                      <span className="flex-1 truncate text-xs">{row.name}</span>
                      {row.badge && (
                        <span
                          className={`shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            row.badge.className ?? 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {row.badge.dotClass && <span className={`h-1.5 w-1.5 rounded-full ${row.badge.dotClass}`} />}
                          {row.badge.label}
                        </span>
                      )}
                    </>
                  )
                  const className =
                    'flex w-full items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 text-left transition-colors hover:bg-accent'
                  return row.to ? (
                    <Link key={row.id} to={row.to} className={className}>
                      {content}
                    </Link>
                  ) : (
                    <button key={row.id} onClick={row.onOpen} className={className}>
                      {content}
                    </button>
                  )
                })
              ) : (
                // A plain line, not EmptyState: at three rows per section its 40px icon
                // would dwarf the content and the card would scroll for empty groups.
                <p className="text-xs text-muted-foreground">{t('workspaces.overview_group_empty')}</p>
              )}
            </div>
          </section>
        )
      })}
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
      <Link to={to} className={`${className} block transition-colors hover:bg-accent`}>
        {content}
      </Link>
    )
  }
  return <div className={className}>{content}</div>
}
