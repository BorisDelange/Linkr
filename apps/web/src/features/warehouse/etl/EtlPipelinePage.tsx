import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Code, Workflow, Table2, Database,
  BookOpen, GitCompare, FileText, Info, MoreHorizontal, Scale,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import type { EtlPipeline } from '@/types'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useUrlTab } from '@/hooks/use-url-tab'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { EtlScriptsTab } from './EtlScriptsTab'
import { EtlPipelineTab } from './EtlPipelineTab'
import { EtlSchemasTab } from './EtlSchemasTab'
import { EtlVocabularyTab } from './EtlVocabularyTab'
import { EtlQualityTab } from './EtlQualityTab'
import { vocabularyReadiness } from './vocabulary-readiness'
import { localized } from '@/lib/localized'

const TAB_IDS = [
  'overview', 'pipeline', 'scripts', 'schemas', 'vocabulary', 'quality', 'readme', 'license',
] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'overview', labelKey: 'databases.detail_overview', icon: Info },
  { id: 'pipeline', labelKey: 'etl.tab_pipeline', icon: Workflow },
  { id: 'scripts', labelKey: 'etl.tab_scripts', icon: Code },
  { id: 'schemas', labelKey: 'etl.tab_schemas', icon: Table2 },
  { id: 'vocabulary', labelKey: 'etl.tab_vocabulary', icon: BookOpen },
  { id: 'quality', labelKey: 'etl.tab_quality', icon: GitCompare },
]

/**
 * Readme and licence fold behind one trigger, as on the mapping project: they
 * are the tabs you reach for occasionally, and this row already carries the
 * source→target selects on its right.
 */
const SECONDARY_TABS = ['readme', 'license'] as const
type SecondaryTabId = (typeof SECONDARY_TABS)[number]

function isSecondaryTab(tab: TabId): tab is SecondaryTabId {
  return (SECONDARY_TABS as readonly string[]).includes(tab)
}

interface Props {
  pipelineId: string
}

export function EtlPipelinePage({ pipelineId }: Props) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const { etlPipelines, etlPipelinesLoaded, loadEtlPipelines, loadPipelineFiles, updatePipeline, files, filesLoaded, activePipelineId } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [activeTab, setActiveTab] = useUrlTab<TabId>({
    key: `etl:${pipelineId}`,
    tabs: TAB_IDS,
    defaultTab: 'overview',
  })
  // Database the schemas tab should open on when the scripts tab sends the user
  // there ("Browse schema"), rather than its own default.
  const [schemasDbId, setSchemasDbId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  // pipelineId may be a short prefix from the URL; resolve to the full id before any store call.
  const pipeline = resolveByIdPrefix(etlPipelines, pipelineId, (p) => p.id)
  const fullPipelineId = pipeline?.id

  useEffect(() => {
    if (fullPipelineId) loadPipelineFiles(fullPipelineId)
  }, [fullPipelineId, loadPipelineFiles])

  // When clicking a script node in the pipeline DAG, switch to scripts tab and
  // select the file. Must stay above the early returns (Rules of Hooks).
  const handleSelectFile = useCallback((fileId: string) => {
    const { selectFile } = useEtlStore.getState()
    selectFile(fileId)
    setActiveTab('scripts')
  }, [setActiveTab])

  /** "Browse schema" in the scripts editor: same view as the Schemas tab, so go
   *  there on the right database instead of opening a modal over the editor. */
  const handleBrowseSchema = useCallback((dataSourceId: string) => {
    setSchemasDbId(dataSourceId)
    setActiveTab('schemas')
  }, [setActiveTab])

  /**
   * Why the Vocabulary tab needs attention, if it does.
   *
   * Above the early returns because it reads the store (Rules of Hooks). Both
   * causes are what a git-imported pipeline arrives in: the mapping project is
   * instance-local, and the STCM export is gitignored so it never travels.
   */
  const vocabAttention = useMemo(() => {
    if (!fullPipelineId) return undefined
    // Only judge the exports once THIS pipeline's files are in: before that the
    // store is empty (or still holds the previous pipeline's), and every export
    // would look missing — a false amber dot on every open.
    const loaded = filesLoaded && activePipelineId === fullPipelineId
    const own = files.filter((f) => f.pipelineId === fullPipelineId)
    if (loaded && !vocabularyReadiness(own).ready) {
      return 'etl.attention_vocab_export_missing'
    }
    return pipeline?.mappingProjectId ? undefined : 'etl.attention_no_mapping_project'
  }, [files, filesLoaded, activePipelineId, fullPipelineId, pipeline?.mappingProjectId])

  if (!etlPipelinesLoaded) return null

  if (!pipeline) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('etl.pipeline_not_found')}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => navigate(paths.warehouseEtl(wsUid ?? ''))}>
          <ArrowLeft size={14} />
          {t('etl.back_to_list')}
        </Button>
      </div>
    )
  }

  /**
   * Which tabs need attention, and why (an i18n key for the dot's tooltip).
   *
   * Both cases are what a git-imported pipeline arrives in: the databases are
   * instance-local so they never travel, and the mapping project is local too.
   * Computed here rather than inside each tab so the dot is visible before the
   * user opens the tab that has the problem.
   */
  const needsAttention: Partial<Record<TabId, string>> = {
    ...(pipeline.sourceDataSourceId && pipeline.targetDataSourceId
      ? {}
      : { pipeline: 'etl.attention_databases' }),
    // A missing export outranks a missing mapping project: it is the more
    // specific problem, and the one whose run-time error names nothing useful.
    ...(vocabAttention ? { vocabulary: vocabAttention } : {}),
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with pipeline tabs */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5 pt-2">
        {/* Spacer: balances the source→target selects on the right so the tabs
            sit centred, matching the database and schema detail pages. */}
        <div className="min-w-0 flex-1" />
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)}>
          <TabsList>
            {TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <tab.icon size={14} />
                {t(tab.labelKey)}
                {/* An amber dot for a tab that needs attention before the pipeline can
                    run. A freshly git-imported pipeline has neither databases nor a
                    dictionary, and without this the first sign of it was a SQL error
                    from a script whose message says nothing about the cause. */}
                {needsAttention[tab.id] && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                    title={t(needsAttention[tab.id]!)}
                    aria-label={t(needsAttention[tab.id]!)}
                  />
                )}
              </TabsTrigger>
            ))}
            <SecondaryTabsTrigger activeTab={activeTab} onSelect={setActiveTab} />
          </TabsList>
        </Tabs>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <Select
            value={pipeline.sourceDataSourceId}
            onValueChange={(value) => updatePipeline(pipeline.id, { sourceDataSourceId: value })}
          >
            <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
              <Database size={12} className="text-muted-foreground" />
              <SelectValue placeholder={t('etl.select_source')} />
            </SelectTrigger>
            <SelectContent>
              {dbSources.map((ds) => (
                <SelectItem key={ds.id} value={ds.id}>
                  {localized(ds.name, i18n.language)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ArrowRight size={12} className="shrink-0 text-muted-foreground" />

          <Select
            value={pipeline.targetDataSourceId ?? ''}
            onValueChange={(value) => updatePipeline(pipeline.id, { targetDataSourceId: value || undefined })}
          >
            <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
              <Database size={12} className="text-muted-foreground" />
              <SelectValue placeholder={t('etl.select_target')} />
            </SelectTrigger>
            <SelectContent>
              {dbSources.map((ds) => (
                <SelectItem key={ds.id} value={ds.id}>
                  {localized(ds.name, i18n.language)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Tab content — full remaining space */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'overview' && (
          <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
            <EtlOverviewTab
              pipeline={pipeline}
              onSeeReadme={() => setActiveTab('readme')}
              onSeeLicense={() => setActiveTab('license')}
            />
          </div>
        )}
        {activeTab === 'readme' && (
          <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
            <EtlReadmeTab pipeline={pipeline} />
          </div>
        )}
        {activeTab === 'license' && (
          <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
            <EtlLicenseTab pipeline={pipeline} />
          </div>
        )}
        {activeTab === 'scripts' && (
          <EtlScriptsTab pipelineId={pipeline.id} onBrowseSchema={handleBrowseSchema} />
        )}
        {activeTab === 'pipeline' && (
          <EtlPipelineTab
            pipelineId={pipeline.id}
            onSelectFile={handleSelectFile}
            onBrowseSchema={handleBrowseSchema}
          />
        )}
        {activeTab === 'schemas' && (
          <EtlSchemasTab pipelineId={pipeline.id} initialDataSourceId={schemasDbId} />
        )}
        {activeTab === 'vocabulary' && <EtlVocabularyTab pipelineId={pipeline.id} />}
        {activeTab === 'quality' && <EtlQualityTab pipelineId={pipeline.id} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Secondary tabs ("...")
// ---------------------------------------------------------------------------

/**
 * One trigger standing in for the occasional tabs.
 *
 * It is a real TabsTrigger for whichever of them is active, so the tab
 * semantics are the ones Radix provides; when none is active it only opens the
 * menu.
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

  const items: { id: SecondaryTabId; label: string; icon: typeof FileText }[] = [
    { id: 'readme', label: t('common.readme'), icon: FileText },
    { id: 'license', label: t('license.title'), icon: Scale },
  ]
  const current = items.find((i) => i.id === active)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <TabsTrigger
          value={active ?? '__secondary__'}
          // TabsTrigger paints "active" from data-state, but DropdownMenuTrigger
          // owns that attribute on a composed trigger and writes open/closed into
          // it. aria-selected stays the tab's own, so drive the styles off that.
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

function EtlReadmeTab({ pipeline }: { pipeline: EtlPipeline }) {
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const updatePipeline = useEtlStore((s) => s.updatePipeline)
  return (
    <EntityReadmePanel
      readme={pipeline.readme}
      onSave={(readme) => updatePipeline(pipeline.id, { readme })}
      canEdit={canWrite}
      attachmentOwner={{ type: 'etl-pipeline', id: pipeline.id, workspaceId: pipeline.workspaceId }}
      // The tab already says "Readme".
      showTitle={false}
    />
  )
}

function EtlLicenseTab({ pipeline }: { pipeline: EtlPipeline }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const updatePipeline = useEtlStore((s) => s.updatePipeline)
  // The pipeline's own frozen provenance wins; otherwise the workspace's live
  // organization — the rule every other licence tab follows.
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === pipeline.workspaceId))
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = pipeline.organization?.name ?? org?.name

  return (
    <EntityLicensePanel
      license={pipeline.license ?? null}
      onSave={(license) => updatePipeline(pipeline.id, { license: license ?? undefined })}
      canEdit={canWrite}
      copyrightHolder={holder ? localized(holder, i18n.language) : undefined}
      showTitle={false}
    />
  )
}

function EtlOverviewTab({
  pipeline,
  onSeeReadme,
  onSeeLicense,
}: {
  pipeline: EtlPipeline
  onSeeReadme: () => void
  onSeeLicense: () => void
}) {
  const { i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments(
    'etl-pipeline',
    pipeline.id,
    pipeline.workspaceId,
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden pt-4">
      {/* The README gets the room — it is what whoever installs this from the
          catalog reads first — with the identity card beside it. `self-start`
          on the second column: the readme stretches to full height and scrolls
          inside itself, while About keeps the height its content needs. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <EtlReadmePreview
          readme={localized(pipeline.readme, i18n.language)}
          resolveUrls={resolveAttachmentUrls}
          onViewFull={onSeeReadme}
        />
        <div className="flex flex-col gap-4 self-start">
          <EtlIdentityCard pipeline={pipeline} onSeeLicense={onSeeLicense} />
        </div>
      </div>
    </div>
  )
}

/** The README, as much of it as fits, with a way through to the whole thing. */
function EtlReadmePreview({
  readme,
  resolveUrls,
  onViewFull,
}: {
  readme: string
  resolveUrls: (md: string) => string
  onViewFull: () => void
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
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onViewFull}>
          {t('summary.view_full')}
          <ArrowUpRight size={12} />
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
            onClick={onViewFull}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('etl.readme_empty_hint')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Who made this pipeline, when, under what licence, and how it is tagged. */
function EtlIdentityCard({
  pipeline,
  onSeeLicense,
}: {
  pipeline: EtlPipeline
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspace = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === pipeline.workspaceId),
  )
  const description = localized(pipeline.description, i18n.language)

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4 rounded-xl border bg-card p-5 pb-0 shadow-sm">
      <div className="flex items-center gap-2">
        <Info size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
      </div>

      {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}

      {!!pipeline.badges?.length && <BadgeStrip badges={pipeline.badges} />}

      {pipeline.version && (
        <div className="flex">
          <Badge variant="outline" className="font-mono">v{pipeline.version}</Badge>
        </div>
      )}

      {/* Author, organization, dates and licence, resolved the same way every
          card footer resolves them (live identity, frozen snapshot fallback).
          The card drops its bottom padding (`pb-0`) because CardMetaFooter
          carries its own pt-3/pb-2, and `-mt-1` trims the container's gap-4 —
          this row is fine print, not a section. */}
      <CardMetaFooter
        className="-mt-1 flex-wrap"
        createdById={pipeline.createdById}
        createdBy={pipeline.createdBy}
        createdByDetails={pipeline.createdByDetails}
        organizationId={pipeline.organization ? undefined : workspace?.organizationId}
        organization={pipeline.organization}
        createdAt={pipeline.createdAt}
        updatedAt={pipeline.updatedAt}
        license={pipeline.license}
        showLicenseWhenEmpty
        onOpenLicense={onSeeLicense}
      />
    </div>
  )
}
