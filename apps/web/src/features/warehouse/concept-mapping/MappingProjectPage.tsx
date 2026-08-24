import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import {
  ArrowRightLeft,
  Pencil,
  BarChart3,
  ChevronDown,
  Download,
  FileText,
  GitBranch,
  Info,
  Library,
  MoreHorizontal,
  Scale,
  Table2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { localized } from '@/lib/localized'
import { getTotalSourceConcepts } from '@/lib/concept-mapping/mapping-status'
import type { MappingProject } from '@/types'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUrlTab } from '@/hooks/use-url-tab'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useVisitStore } from '@/stores/visit-store'
import { unmountFileSource } from '@/lib/duckdb/engine'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import { ConceptSetsTab } from './ConceptSetsTab'
import { MappingEditorTab } from './MappingEditorTab'
import { MappingsTab } from './MappingsTab'
import { ProgressTab } from './ProgressTab'
import { ExportTab } from './ExportTab'

interface MappingProjectPageProps {
  projectId: string
}

const TABS = ['overview', 'progress', 'concept-sets', 'editor', 'mappings', 'export', 'readme', 'license', 'versioning'] as const
type TabId = (typeof TABS)[number]

export function MappingProjectPage({ projectId }: MappingProjectPageProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useUrlTab<TabId>({
    key: `mapping-project:${projectId}`,
    tabs: TABS,
    defaultTab: 'overview',
  })

  // Set by the overview's Edit button so the Readme tab opens in edit mode.
  // Cleared on the way out, or reaching the tab through its own trigger later
  // would land in the editor unasked.
  const [readmeEditing, setReadmeEditing] = useState(false)
  // Cleared only once the Readme tab has actually been left. Checking
  // `activeTab !== 'readme'` during render would fire immediately instead:
  // setActiveTab writes the URL, so activeTab is still the previous tab on the
  // render right after the Edit click, and the flag died before it was read.
  const wasOnReadme = useRef(false)
  useEffect(() => {
    if (activeTab === 'readme') wasOnReadme.current = true
    else if (wasOnReadme.current) {
      wasOnReadme.current = false
      setReadmeEditing(false)
    }
  }, [activeTab])
  // Once the editor has been opened at least once, keep its component mounted so
  // its (expensive) source-concepts query and DuckDB cache survive tab switches.
  // The other tabs stay lazy — their store subscriptions are too heavy to leave
  // running in the background.
  const editorEverOpened = useRef(false)
  useEffect(() => {
    if (activeTab === 'editor') editorEverOpened.current = true
  }, [activeTab])
  const {
    mappingProjects, mappingProjectsLoaded, loadMappingProjects,
    conceptSetsLoaded, loadConceptSets,
    loadProjectMappings, updateMappingProject,
  } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
    if (!conceptSetsLoaded) loadConceptSets()
  }, [mappingProjectsLoaded, loadMappingProjects, conceptSetsLoaded, loadConceptSets])

  useEffect(() => {
    loadProjectMappings(projectId)
  }, [projectId, loadProjectMappings])

  useEffect(() => {
    if (!projectId) return
    const id = setTimeout(() => useVisitStore.getState().recordVisit('mapping-project', projectId), 400)
    return () => clearTimeout(id)
  }, [projectId])

  // Free DuckDB memory when leaving the project. The CSV file source can hold ~200 MB
  // of in-memory tables — releasing it lets the user open another large project without
  // accumulating heap pressure.
  useEffect(() => {
    return () => {
      void unmountFileSource(projectId).catch(() => {})
    }
  }, [projectId])

  const project = mappingProjects.find((p) => p.id === projectId)
  const isFileSource = project?.sourceType === 'file'
  const dataSource = project && !isFileSource ? dataSources.find((ds) => ds.id === project.dataSourceId) : undefined

  if (!mappingProjectsLoaded) return null

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.project_not_found')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tabs — centered */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)} className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-center px-6 pt-2">
          <TabsList>
            <TabsTrigger value="overview">
              <Info size={14} />
              {t('databases.detail_overview')}
            </TabsTrigger>
            <TabsTrigger value="progress">
              <BarChart3 size={14} />
              {t('concept_mapping.tab_progress')}
            </TabsTrigger>
            <TabsTrigger value="concept-sets">
              <Library size={14} />
              {t('concept_mapping.tab_concept_sets')}
            </TabsTrigger>
            <TabsTrigger value="editor">
              <ArrowRightLeft size={14} />
              {t('concept_mapping.tab_editor')}
            </TabsTrigger>
            <TabsTrigger value="mappings">
              <Table2 size={14} />
              {t('concept_mapping.tab_mappings')}
            </TabsTrigger>
            {/* Export, versioning, readme and licence are the tabs you reach for
                occasionally, not while mapping. Nine triggers made the row hard
                to scan, so they fold into one — which still renders as the
                active tab when you are on one of them. */}
            <SecondaryTabsTrigger activeTab={activeTab} onSelect={setActiveTab} />
          </TabsList>
        </div>
        {/* Render only the active tab — except the editor, which is kept mounted
            once first opened so the source-concepts table (a multi-second DuckDB
            query for large projects) doesn't reload on every tab switch. The
            other tabs stay lazy because their subscriptions to the mappings
            store would otherwise stall the UI on every vote. */}
        {/* No stat cards here: the Progress tab already leads with the counts,
            and repeating them would make the overview a worse copy of it. This
            tab answers "what is this project and who made it" instead. */}
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-hidden">
          {activeTab === 'overview' && (
            <div className="flex h-full flex-col px-6 pb-1.5">
              <MappingProjectOverviewTab
                project={project}
                onSeeProgress={() => setActiveTab('progress')}
                onEditReadme={() => { setReadmeEditing(true); setActiveTab('readme') }}
                onSeeLicense={() => setActiveTab('license')}
              />
            </div>
          )}
        </TabsContent>
        <TabsContent value="progress" className="flex-1 overflow-hidden">
          {activeTab === 'progress' && <ProgressTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="concept-sets" className="flex-1 overflow-hidden">
          {activeTab === 'concept-sets' && <ConceptSetsTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="editor" forceMount className={`flex-1 overflow-hidden ${activeTab === 'editor' ? '' : 'hidden'}`}>
          {/* eslint-disable-next-line react-hooks/refs -- monotonic "sticky mount" latch: once true it never flips back, and it is set in an activeTab effect that already re-renders this component, so reading it here keeps the editor mounted without going stale */}
          {(activeTab === 'editor' || editorEverOpened.current) && (
            <MappingEditorTab project={project} dataSource={dataSource} onGoToConceptSets={() => setActiveTab('concept-sets')} />
          )}
        </TabsContent>
        <TabsContent value="mappings" className="flex-1 overflow-hidden">
          {activeTab === 'mappings' && <MappingsTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="export" className="flex-1 overflow-hidden">
          {activeTab === 'export' && <ExportTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="readme" className="min-h-0 flex-1 overflow-hidden">
          {activeTab === 'readme' && (
            <div className="flex h-full flex-col px-6 pb-1.5">
              <MappingProjectReadmeTab project={project} editing={readmeEditing} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="license" className="min-h-0 flex-1 overflow-hidden">
          {activeTab === 'license' && (
            <div className="flex h-full flex-col px-6 pb-1.5">
              <MappingProjectLicenseTab project={project} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="versioning" className="min-h-0 flex-1 overflow-hidden">
          {activeTab === 'versioning' && (
            <div className="mx-auto flex min-h-0 h-full w-full max-w-3xl flex-col px-6 py-6">
              {/* Git repository link + push-only sync panel. The mapping project
                  has its own Export tab, so no export UI here. */}
              <GitRepositoryTab
                gitRemote={project.gitRemoteConfig ?? null}
                onSave={(cfg) => updateMappingProject(project.id, { gitRemoteConfig: cfg ?? undefined })}
                syncScope="mapping-projects"
                syncId={project.id}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Secondary tabs ("...")
// ---------------------------------------------------------------------------

/** The tabs that fold into the "..." trigger, in the order they appear there. */
const SECONDARY_TABS = ['readme', 'license', 'export', 'versioning'] as const
type SecondaryTabId = (typeof SECONDARY_TABS)[number]

function isSecondaryTab(tab: TabId): tab is SecondaryTabId {
  return (SECONDARY_TABS as readonly string[]).includes(tab)
}

/**
 * One trigger standing in for four occasional tabs.
 *
 * It is a real TabsTrigger for whichever of the four is active, so the active
 * styling and the tab semantics are the ones Radix already provides; when none
 * is active it is an inert trigger that only opens the menu.
 */
function SecondaryTabsTrigger({
  activeTab,
  onSelect,
}: {
  activeTab: TabId
  onSelect: (tab: TabId) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = isSecondaryTab(activeTab) ? activeTab : undefined

  const items: { id: SecondaryTabId; label: string; icon: typeof Download }[] = [
    { id: 'readme', label: t('common.readme'), icon: FileText },
    { id: 'license', label: t('license.title'), icon: Scale },
    { id: 'export', label: t('concept_mapping.tab_export'), icon: Download },
    { id: 'versioning', label: t('common.versioning'), icon: GitBranch },
  ]
  const current = items.find((i) => i.id === active)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {/* `value` only when one of the four is active: giving it a value that
            is never the active tab would leave a permanently inactive trigger,
            and giving it the active tab's value when it isn't would steal the
            selection from the real trigger. */}
        <TabsTrigger
          value={active ?? '__secondary__'}
          // TabsTrigger paints "active" from data-state, but DropdownMenuTrigger
          // owns that attribute here and writes open/closed into it. aria-selected
          // is still the tab's own (Radix sets it from the value), so drive the
          // same styles off it.
          className="aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
          // The menu is the point: let it open instead of switching tab.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.preventDefault(); setOpen((v) => !v) }}
        >
          {current ? <current.icon size={14} /> : <MoreHorizontal size={14} />}
          {current ? current.label : t('common.more')}
          <ChevronDown size={12} className="opacity-60" />
        </TabsTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => onSelect(item.id)}
            className={item.id === active ? 'bg-accent' : undefined}
          >
            <item.icon size={14} className="text-muted-foreground" />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Overview, readme and licence tabs
// ---------------------------------------------------------------------------

function MappingProjectReadmeTab({ project, editing }: { project: MappingProject; editing?: boolean }) {
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const updateMappingProject = useConceptMappingStore((s) => s.updateMappingProject)
  return (
    <EntityReadmePanel
      // Remounted when arriving from the overview's Edit button, so the
      // editor picks up the requested mode — initialMode only applies on mount.
      key={editing ? 'edit' : 'view'}
      initialMode={editing ? 'edit' : 'view'}
      readme={project.readme}
      onSave={(readme) => updateMappingProject(project.id, { readme })}
      canEdit={canWrite}
      attachmentOwner={{ type: 'mapping-project', id: project.id, workspaceId: project.workspaceId }}
      // The tab already says "Readme".
      showTitle={false}
    />
  )
}

function MappingProjectLicenseTab({ project }: { project: MappingProject }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const updateMappingProject = useConceptMappingStore((s) => s.updateMappingProject)
  // The project's own frozen provenance wins; otherwise the workspace's live
  // organization — the rule every other licence tab follows.
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === project.workspaceId))
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = project.organization?.name ?? org?.name

  return (
    <EntityLicensePanel
      license={project.license ?? null}
      onSave={(license) => updateMappingProject(project.id, { license: license ?? undefined })}
      canEdit={canWrite}
      copyrightHolder={holder ? localized(holder, i18n.language) : undefined}
      showTitle={false}
    />
  )
}

function MappingProjectOverviewTab({
  project,
  onSeeProgress,
  onEditReadme,
  onSeeLicense,
}: {
  project: MappingProject
  onSeeProgress: () => void
  onEditReadme: () => void
  onSeeLicense: () => void
}) {
  const { i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments(
    'mapping-project',
    project.id,
    project.workspaceId,
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden pt-4">
      {/* The README gets the room — it is what whoever installs this from the
          catalog reads first — with the identity card beside it. `self-start`
          on the second column: the readme stretches to full height and scrolls
          inside itself, while About keeps the height its content needs. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <MappingProjectReadmePreview
          readme={localized(project.readme, i18n.language)}
          resolveUrls={resolveAttachmentUrls}
          onEdit={onEditReadme}
        />
        <div className="flex flex-col gap-4 self-start">
          <MappingProjectIdentityCard project={project} onSeeLicense={onSeeLicense} />
          <MappingProjectProgressCard project={project} onSeeProgress={onSeeProgress} />
        </div>
      </div>
    </div>
  )
}

/** The README, as much of it as fits, with a way through to the whole thing. */
function MappingProjectReadmePreview({
  readme,
  resolveUrls,
  onEdit,
}: {
  readme: string
  resolveUrls: (md: string) => string
  onEdit: () => void
}) {
  const { t } = useTranslation()
  // Rewrite attachments/<file> paths to blob URLs so images render, as the
  // README tab does before handing the markdown to the renderer.
  const resolved = resolveUrls(readme)

  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 pr-2 shadow-sm">
      <div className="flex shrink-0 items-center justify-between pr-3">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('common.readme')}</h3>
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onEdit}>
          <Pencil size={12} />
          {t('common.edit')}
        </Button>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-3">
        {readme.trim() ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              urlTransform={urlTransform}
            >
              {resolved}
            </ReactMarkdown>
          </div>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('concept_mapping.readme_empty_hint')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Who made this project, when, under what licence, and how it is tagged. */
function MappingProjectIdentityCard({
  project,
  onSeeLicense,
}: {
  project: MappingProject
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspace = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === project.workspaceId),
  )
  const description = localized(project.description, i18n.language)

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4 rounded-xl border bg-card p-5 pb-0 shadow-sm">
      <div className="flex items-center gap-2">
        <Info size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
      </div>

      {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}

      {!!project.badges?.length && <BadgeStrip badges={project.badges} />}

      {project.version && (
        <div className="flex">
          <Badge variant="outline" className="font-mono">v{project.version}</Badge>
        </div>
      )}

      {/* Author, organization, dates and licence, resolved the same way every
          card footer resolves them (live identity, frozen snapshot fallback).
          The card drops its bottom padding (`pb-0`) because CardMetaFooter
          carries its own pt-3/pb-2, and `-mt-1` trims the container's gap-4 —
          this row is fine print, not a section. */}
      <CardMetaFooter
        className="-mt-1"
        stacked
        createdById={project.createdById}
        createdBy={project.createdBy}
        createdByDetails={project.createdByDetails}
        organizationId={project.organization ? undefined : workspace?.organizationId}
        organization={project.organization}
        createdAt={project.createdAt}
        updatedAt={project.updatedAt}
        license={project.license}
        showLicenseWhenEmpty
        onOpenLicense={onSeeLicense}
      />
    </div>
  )
}

/**
 * How far the mapping has got, as one line rather than a row of stat cards:
 * the Progress tab owns the figures, so this is a way in, not a second copy.
 */
function MappingProjectProgressCard({
  project,
  onSeeProgress,
}: {
  project: MappingProject
  onSeeProgress: () => void
}) {
  const { t } = useTranslation()
  const stats = project.stats
  // `stats.totalSourceConcepts` is a cached figure that is 0 for a database
  // project until something recomputes it — the Progress tab gets the real
  // number by querying the source. getTotalSourceConcepts applies the same
  // fallback the rest of the app uses; when even that yields nothing, show no
  // percentage rather than a wrong one ("1552 of 0").
  const total = getTotalSourceConcepts(project)
  if (!stats || total <= 0) return null

  const mapped = stats.mappedCount
  const pct = Math.min(100, Math.round((mapped / total) * 100))

  return (
    <button
      type="button"
      onClick={onSeeProgress}
      className="flex shrink-0 flex-col gap-3 rounded-xl border bg-card p-5 text-left shadow-sm transition-colors hover:bg-accent"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('concept_mapping.tab_progress')}</h3>
        </div>
        <span className="text-sm font-semibold tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('concept_mapping.overview_mapped_of', {
          mapped: mapped.toLocaleString(),
          total: total.toLocaleString(),
        })}
      </p>
    </button>
  )
}
