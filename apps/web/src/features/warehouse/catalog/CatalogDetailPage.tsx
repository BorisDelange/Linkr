import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  ArrowLeft,
  BookOpen,
  Database,
  Info,
  Settings2,
  Table2,
  ShieldCheck,
  Tags,
  Download,
  Upload,
  FileText,
  Scale,
  GitBranch,
  MoreHorizontal,
  ChevronDown,
  Pencil,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import ReactMarkdown from 'react-markdown'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useUrlTab } from '@/hooks/use-url-tab'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useCatalogActions } from './use-catalog-actions'
import { CatalogConfigTab } from './CatalogConfigTab'
import { CatalogDataTab } from './CatalogDataTab'
import { CatalogAnonymizationTab } from './CatalogAnonymizationTab'
import { CatalogDcatTab } from './CatalogDcatTab'
import { CatalogExportTab } from './CatalogExportTab'
import type { CatalogStatus, DataCatalog } from '@/types'

const STATUS_BADGE: Record<CatalogStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'secondary', label: 'data_catalog.status_draft' },
  ready: { variant: 'outline', label: 'data_catalog.status_ready' },
  computing: { variant: 'default', label: 'data_catalog.status_computing' },
  success: { variant: 'default', label: 'data_catalog.status_success' },
  error: { variant: 'destructive', label: 'data_catalog.status_error' },
}

const TAB_IDS = [
  'overview', 'config', 'data', 'anonymization', 'dcat', 'export',
  'readme', 'license', 'versioning',
] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'overview', labelKey: 'databases.detail_overview', icon: Info },
  { id: 'config', labelKey: 'data_catalog.tab_config', icon: Settings2 },
  { id: 'data', labelKey: 'data_catalog.tab_data', icon: Table2 },
  { id: 'anonymization', labelKey: 'data_catalog.tab_anonymization', icon: ShieldCheck },
  { id: 'dcat', labelKey: 'data_catalog.tab_dcat', icon: Tags },
  // Publishes the catalog as a DCAT-AP site (HTML + CSV + JSON-LD). Named
  // "Publish", not "Export", so it doesn't collide with the "..." menu's
  // Export, which downloads the entity ZIP — a different thing entirely.
  { id: 'export', labelKey: 'data_catalog.tab_publish', icon: Upload },
]

/**
 * Readme, licence, export and versioning fold behind one trigger, as on every
 * other entity page.
 *
 * Export is not a tab here either: the catalog's own Export tab publishes
 * DCAT-AP, while this one downloads the entity ZIP.
 */
const SECONDARY_TABS = ['readme', 'license', 'versioning'] as const
type SecondaryTabId = (typeof SECONDARY_TABS)[number]

function isSecondaryTab(tab: TabId): tab is SecondaryTabId {
  return (SECONDARY_TABS as readonly string[]).includes(tab)
}

interface Props {
  catalogId: string
}

export function CatalogDetailPage({ catalogId }: Props) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useUrlTab<TabId>({
    key: `catalog:${catalogId}`,
    tabs: TAB_IDS,
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
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { catalogs, catalogsLoaded, loadCatalogs, activeResultCache, loadResultCache, updateCatalog } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const catalogActions = useCatalogActions()
  const canWrite = useMyWorkspaceRole().can('catalog:write')
  const { activeWorkspaceId } = useWorkspaceStore()
  const catalogListPath = `/workspaces/${activeWorkspaceId}/warehouse/catalog`

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  // Load cached results on mount
  useEffect(() => {
    loadResultCache(catalogId)
  }, [catalogId, loadResultCache])

  const catalog = catalogs.find((c) => c.id === catalogId)

  if (!catalog) {
    return (
      <div className="h-full overflow-auto">
        <div className="px-6 py-6">
          <Button variant="ghost" size="sm" onClick={() => navigate(catalogListPath)}>
            <ArrowLeft size={14} />
            {t('data_catalog.back_to_list')}
          </Button>
          <Card className="mt-4">
            <div className="flex flex-col items-center py-12">
              <BookOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium">{t('data_catalog.not_found')}</p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  const statusInfo = STATUS_BADGE[catalog.status]
  const sourceName = localized(dataSources.find((ds) => ds.id === catalog.dataSourceId)?.name, language) || '—'

  // A failed compute explains itself on hover; every other status is the badge
  // alone. Built here so the About card renders the same thing the page header
  // used to.
  const statusBadge =
    catalog.status === 'error' && catalog.lastError ? (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={statusInfo.variant} className="cursor-help">
              {t(statusInfo.label)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <p className="text-xs">{catalog.lastError}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : (
      <Badge variant={statusInfo.variant}>{t(statusInfo.label)}</Badge>
    )

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-6">
        {/* No page header: the catalog's name lives in the global header badge
            like every other entity, and its status and source now sit in the
            overview's About card. */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)}>
          <TabsList className="mx-auto w-fit">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <tab.icon size={14} />
                {t(tab.labelKey)}
              </TabsTrigger>
            ))}
            <SecondaryTabsTrigger
              activeTab={activeTab}
              onSelect={setActiveTab}
              onExport={() => void catalogActions.onExport(catalog)}
            />
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <CatalogOverviewTab
              catalog={catalog}
              statusBadge={statusBadge}
              sourceName={sourceName}
              onEditReadme={() => { setReadmeEditing(true); setActiveTab('readme') }}
              onSeeLicense={() => setActiveTab('license')}
            />
          </TabsContent>

          <TabsContent value="readme" className="mt-4">
            <EntityReadmePanel
              // Remounted when arriving from the overview's Edit button, so the
              // editor picks up the requested mode — initialMode only applies on mount.
              key={readmeEditing ? 'edit' : 'view'}
              initialMode={readmeEditing ? 'edit' : 'view'}
              readme={catalog.readme}
              onSave={(readme) => updateCatalog(catalog.id, { readme })}
              canEdit={canWrite}
              attachmentOwner={{ type: 'data-catalog', id: catalog.id, workspaceId: catalog.workspaceId }}
              // The tab already says "Readme".
              showTitle={false}
            />
          </TabsContent>

          <TabsContent value="license" className="mt-4">
            <CatalogLicenseTab catalog={catalog} />
          </TabsContent>

          <TabsContent value="versioning" className="mt-4">
            <div className="mx-auto w-full max-w-3xl">
              {/* Git link + push-only sync panel. Export is a menu action here,
                  so no export UI in this tab. */}
              <GitRepositoryTab
                gitRemote={catalog.gitRemoteConfig ?? null}
                onSave={(cfg) => updateCatalog(catalog.id, { gitRemoteConfig: cfg ?? undefined })}
                syncScope="data-catalogs"
                syncId={catalog.id}
              />
            </div>
          </TabsContent>

          <TabsContent value="config" className="mt-4">
            <CatalogConfigTab catalog={catalog} />
          </TabsContent>

          <TabsContent value="data" className="mt-4">
            {activeResultCache ? (
              <CatalogDataTab catalog={catalog} cache={activeResultCache} />
            ) : (
              <Card>
                <div className="flex flex-col items-center py-12">
                  <BookOpen size={40} className="text-muted-foreground" />
                  <p className="mt-4 text-sm font-medium">{t('data_catalog.no_data')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('data_catalog.no_data_description')}
                  </p>
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="anonymization" className="mt-4">
            {activeResultCache ? (
              <CatalogAnonymizationTab catalog={catalog} cache={activeResultCache} />
            ) : (
              <Card>
                <div className="flex flex-col items-center py-12">
                  <BookOpen size={40} className="text-muted-foreground" />
                  <p className="mt-4 text-sm font-medium">{t('data_catalog.no_data')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('data_catalog.no_data_description')}
                  </p>
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="dcat" className="mt-4">
            <CatalogDcatTab catalog={catalog} cache={activeResultCache} />
          </TabsContent>

          <TabsContent value="export" className="mt-4">
            {activeResultCache ? (
              <CatalogExportTab catalog={catalog} cache={activeResultCache} />
            ) : (
              <Card>
                <div className="flex flex-col items-center py-12">
                  <BookOpen size={40} className="text-muted-foreground" />
                  <p className="mt-4 text-sm font-medium">{t('data_catalog.no_data')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('data_catalog.no_data_description')}
                  </p>
                </div>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview, licence tabs
// ---------------------------------------------------------------------------

function CatalogOverviewTab({
  catalog,
  statusBadge,
  sourceName,
  onEditReadme,
  onSeeLicense,
}: {
  catalog: DataCatalog
  statusBadge: React.ReactNode
  sourceName: string
  onEditReadme: () => void
  onSeeLicense: () => void
}) {
  const { i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments(
    'data-catalog',
    catalog.id,
    catalog.workspaceId,
  )

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {/* The README gets the room — it is what whoever installs this from the
          catalog reads first — with the identity card beside it. `self-start`
          on the second column: the readme stretches to full height and scrolls
          inside itself, while About keeps the height its content needs. */}
      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <CatalogReadmePreview
          readme={localized(catalog.readme, i18n.language)}
          resolveUrls={resolveAttachmentUrls}
          onEdit={onEditReadme}
        />
        <div className="flex flex-col gap-4 self-start">
          <CatalogIdentityCard
            catalog={catalog}
            statusBadge={statusBadge}
            sourceName={sourceName}
            onSeeLicense={onSeeLicense}
          />
        </div>
      </div>
    </div>
  )
}

/** The README, as much of it as fits, with a way through to the whole thing. */
function CatalogReadmePreview({
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
    <div className="flex max-h-[32rem] min-h-0 flex-col rounded-xl border bg-card p-5 pr-2 shadow-sm">
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
            {t('data_catalog.readme_empty_hint')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Who made this catalog, when, under what licence, and how it is tagged. */
function CatalogIdentityCard({
  catalog,
  statusBadge,
  sourceName,
  onSeeLicense,
}: {
  catalog: DataCatalog
  statusBadge: React.ReactNode
  sourceName: string
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspace = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === catalog.workspaceId),
  )
  const description = localized(catalog.description, i18n.language)

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4 rounded-xl border bg-card p-5 pb-0 shadow-sm">
      <div className="flex items-center gap-2">
        <Info size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
      </div>

      {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}

      {/* Status and source database — the two facts the removed page header
          carried, kept where the rest of the identity lives. */}
      <div className="flex flex-wrap items-center gap-2">
        {statusBadge}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Database size={12} className="shrink-0" />
          <span className="truncate">{sourceName}</span>
        </span>
      </div>

      {!!catalog.badges?.length && <BadgeStrip badges={catalog.badges} />}

      {catalog.version && (
        <div className="flex">
          <Badge variant="outline" className="font-mono">v{catalog.version}</Badge>
        </div>
      )}

      {/* Author, organization, dates and licence, resolved the same way every
          card footer resolves them (live identity, frozen snapshot fallback).
          The card drops its bottom padding (`pb-0`) because CardMetaFooter
          carries its own pt-3/pb-2, and `-mt-1` trims the container's gap-4 —
          this row is fine print, not a section. */}
      <CardMetaFooter
        className="-mt-1"
        createdById={catalog.createdById}
        createdBy={catalog.createdBy}
        createdByDetails={catalog.createdByDetails}
        organizationId={catalog.organization ? undefined : workspace?.organizationId}
        organization={catalog.organization}
        createdAt={catalog.createdAt}
        updatedAt={catalog.updatedAt}
        license={catalog.license}
        showLicenseWhenEmpty
        onOpenLicense={onSeeLicense}
      />
    </div>
  )
}

function CatalogLicenseTab({ catalog }: { catalog: DataCatalog }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('catalog:write')
  const updateCatalog = useCatalogStore((s) => s.updateCatalog)
  // The catalog's own frozen provenance wins; otherwise the workspace's live
  // organization — the rule every other licence tab follows.
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === catalog.workspaceId))
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = catalog.organization?.name ?? org?.name

  return (
    <EntityLicensePanel
      license={catalog.license ?? null}
      onSave={(license) => updateCatalog(catalog.id, { license: license ?? undefined })}
      canEdit={canWrite}
      copyrightHolder={holder ? localized(holder, i18n.language) : undefined}
      showTitle={false}
    />
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
  onExport,
}: {
  activeTab: TabId
  onSelect: (tab: TabId) => void
  onExport: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = isSecondaryTab(activeTab) ? activeTab : undefined

  // Export downloads the entity ZIP rather than opening a view, so it has no
  // tab id and never becomes the active one. (The catalog's own Export tab is a
  // different thing: it publishes DCAT-AP.)
  const items: { id: SecondaryTabId | 'export'; label: string; icon: typeof FileText }[] = [
    { id: 'readme', label: t('common.readme'), icon: FileText },
    { id: 'license', label: t('license.title'), icon: Scale },
    { id: 'export', label: t('common.export'), icon: Download },
    { id: 'versioning', label: t('common.versioning'), icon: GitBranch },
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
            onSelect={() => { if (item.id === 'export') onExport(); else onSelect(item.id) }}
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
