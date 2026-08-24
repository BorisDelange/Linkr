import { useEffect, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  ArrowLeft,
  Code,
  BarChart3,
  Info,
  FileText,
  Scale,
  Download,
  GitBranch,
  MoreHorizontal,
  ChevronDown,
  Pencil,
} from 'lucide-react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useUrlTab } from '@/hooks/use-url-tab'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import ReactMarkdown from 'react-markdown'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { cn } from '@/lib/utils'
import { useDqStore } from '@/stores/dq-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useDqRuleSetActions } from './use-dq-rule-set-actions'
import { DqChecksTab } from './DqChecksTab'
import { DqResultsView } from './DqResultsView'
import type { DqReport } from '@/lib/duckdb/data-quality'
import type { DqRuleSet } from '@/types'
import { localized } from '@/lib/localized'

const TAB_IDS = ['overview', 'checks', 'results', 'readme', 'license', 'versioning'] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'overview', labelKey: 'databases.detail_overview', icon: Info },
  { id: 'checks', labelKey: 'data_quality.tab_checks', icon: Code },
  { id: 'results', labelKey: 'data_quality.tab_results', icon: BarChart3 },
]

/**
 * Readme, licence, export and versioning fold behind one trigger, as on the ETL
 * pipeline, the schema, the mapping project, the database and the SQL collection.
 *
 * 'export' is not a tab of its own — a rule set exports as a ZIP download, so
 * selecting it runs the action and leaves the active tab alone.
 */
const SECONDARY_TABS = ['readme', 'license', 'versioning'] as const
type SecondaryTabId = (typeof SECONDARY_TABS)[number]

function isSecondaryTab(tab: TabId): tab is SecondaryTabId {
  return (SECONDARY_TABS as readonly string[]).includes(tab)
}

interface Props {
  ruleSetId: string
}

export function DqRuleSetDetailPage({ ruleSetId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const {
    dqRuleSets,
    dqRuleSetsLoaded,
    loadDqRuleSets,
    loadRuleSetChecks,
    updateRuleSet,
    customChecks,
    addRunHistory,
    loadRunHistory,
  } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const [activeTab, setActiveTab] = useUrlTab<TabId>({
    key: `dq:${ruleSetId}`,
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
  const dqActions = useDqRuleSetActions()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')

  useEffect(() => {
    if (!dqRuleSetsLoaded) loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  // ruleSetId may be a short prefix from the URL; resolve to the full id before any store call.
  const ruleSet = resolveByIdPrefix(dqRuleSets, ruleSetId, (rs) => rs.id)
  const fullRuleSetId = ruleSet?.id

  useEffect(() => {
    if (fullRuleSetId) loadRuleSetChecks(fullRuleSetId)
  }, [fullRuleSetId, loadRuleSetChecks])

  useEffect(() => {
    if (fullRuleSetId) void loadRunHistory(fullRuleSetId)
  }, [fullRuleSetId, loadRunHistory])
  const activeSource = dataSources.find((ds) => ds.id === ruleSet?.dataSourceId)

  const handleBack = useCallback(() => {
    // Navigate to the data-quality list page using absolute path
    if (wsUid) {
      navigate(paths.warehouseDataQuality(wsUid))
    } else {
      navigate('..')
    }
  }, [wsUid, navigate])

  const handleScanComplete = useCallback((report: DqReport) => {
    if (!ruleSet) return

    const applicable = report.summary.total - report.summary.notApplicable
    const score = applicable > 0 ? Math.round((report.summary.passed / applicable) * 100) : 100
    const durationMs = report.results.reduce((sum, r) => sum + r.executionTimeMs, 0)

    void updateRuleSet(ruleSet.id, {
      status: report.summary.failed > 0 ? 'error' : 'success',
      lastRunAt: report.computedAt,
      lastRunDurationMs: durationMs,
      lastScore: score,
    }).catch((e) => console.warn('[dq] rule-set persist:', e))

    void addRunHistory({
      id: crypto.randomUUID(),
      ruleSetId: ruleSet.id,
      dataSourceId: ruleSet.dataSourceId,
      startedAt: report.computedAt,
      completedAt: new Date().toISOString(),
      status: 'success',
      score,
      totalChecks: report.summary.total,
      passed: report.summary.passed,
      failed: report.summary.failed,
      errors: report.summary.errors,
      notApplicable: report.summary.notApplicable,
      durationMs,
      report,
    }).catch((e) => console.warn('[dq] run-history persist:', e))
  }, [ruleSet, updateRuleSet, addRunHistory])

  if (!dqRuleSetsLoaded) return null

  if (!ruleSet) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('data_quality.rs_not_found')}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={handleBack}>
          <ArrowLeft size={14} />
          {t('data_quality.back_to_list')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabId)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center px-6 pt-2">
          {/* Balances the database picker so the tabs sit centred, as on the
              database, schema and ETL pipeline pages. */}
          <div className="min-w-0 flex-1" />
          <TabsList>
            {TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <tab.icon size={14} />
                {t(tab.labelKey)}
              </TabsTrigger>
            ))}
            <SecondaryTabsTrigger
              activeTab={activeTab}
              onSelect={setActiveTab}
              onExport={() => void dqActions.onExport(ruleSet)}
            />
          </TabsList>
          {/* Balances the left spacer so the tabs stay centred. The database
              picker moved into the Checks tab, beside the Test button it
              governs. */}
          <div className="min-w-0 flex-1" />
        </div>

        <TabsContent value="overview" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <DqOverviewTab
              ruleSet={ruleSet}
              onEditReadme={() => { setReadmeEditing(true); setActiveTab('readme') }}
              onSeeLicense={() => setActiveTab('license')}
            />
          </div>
        </TabsContent>

        <TabsContent value="readme" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <EntityReadmePanel
              // Remounted when arriving from the overview's Edit button, so the
              // editor picks up the requested mode — initialMode only applies on mount.
              key={readmeEditing ? 'edit' : 'view'}
              initialMode={readmeEditing ? 'edit' : 'view'}
              readme={ruleSet.readme}
              onSave={(readme) => updateRuleSet(ruleSet.id, { readme })}
              canEdit={canWrite}
              attachmentOwner={{ type: 'dq-rule-set', id: ruleSet.id, workspaceId: ruleSet.workspaceId }}
              // The tab already says "Readme".
              showTitle={false}
            />
          </div>
        </TabsContent>

        <TabsContent value="license" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <DqLicenseTab ruleSet={ruleSet} />
          </div>
        </TabsContent>

        <TabsContent value="versioning" className="m-0 min-h-0 flex-1 p-0">
          <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col px-6 py-6">
            {/* Git link + push-only sync panel. Export is a menu action here, so
                no export UI in this tab. */}
            <GitRepositoryTab
              gitRemote={ruleSet.gitRemoteConfig ?? null}
              onSave={(cfg) => updateRuleSet(ruleSet.id, { gitRemoteConfig: cfg ?? undefined })}
              syncScope="dq-rule-sets"
              syncId={ruleSet.id}
            />
          </div>
        </TabsContent>

        {/* Checks and Results stay MOUNTED (hidden when inactive) so their in-tab
            state — scan report, filters, selection, search — survives switching
            tabs, which a TabsContent would discard. */}
        <div
          className={cn(
            'min-h-0 flex-1 overflow-hidden border-t',
            activeTab !== 'checks' && activeTab !== 'results' && 'hidden',
          )}
        >
          <div className={cn('h-full', activeTab !== 'checks' && 'hidden')}>
            <DqChecksTab ruleSetId={ruleSet.id} dataSourceId={ruleSet.dataSourceId} />
          </div>
          <div className={cn('h-full', activeTab !== 'results' && 'hidden')}>
            <DqResultsView
              ruleSetId={ruleSet.id}
              dataSourceId={ruleSet.dataSourceId}
              schemaMapping={activeSource?.schemaMapping}
              customChecks={customChecks}
              onScanComplete={handleScanComplete}
              onBeforeScan={() => ensureMounted(ruleSet.dataSourceId)}
            />
          </div>
        </div>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview, licence tabs
// ---------------------------------------------------------------------------

function DqOverviewTab({
  ruleSet,
  onEditReadme,
  onSeeLicense,
}: {
  ruleSet: DqRuleSet
  onEditReadme: () => void
  onSeeLicense: () => void
}) {
  const { i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments(
    'dq-rule-set',
    ruleSet.id,
    ruleSet.workspaceId,
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden pt-4">
      {/* The README gets the room — it is what whoever installs this from the
          catalog reads first — with the identity card beside it. `self-start`
          on the second column: the readme stretches to full height and scrolls
          inside itself, while About keeps the height its content needs. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <DqReadmePreview
          readme={localized(ruleSet.readme, i18n.language)}
          resolveUrls={resolveAttachmentUrls}
          onEdit={onEditReadme}
        />
        <div className="flex flex-col gap-4 self-start">
          <DqIdentityCard ruleSet={ruleSet} onSeeLicense={onSeeLicense} />
        </div>
      </div>
    </div>
  )
}

/** The README, as much of it as fits, with a way through to the whole thing. */
function DqReadmePreview({
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
            {t('data_quality.readme_empty_hint')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Who made this rule set, when, under what licence, and how it is tagged. */
function DqIdentityCard({
  ruleSet,
  onSeeLicense,
}: {
  ruleSet: DqRuleSet
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspace = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === ruleSet.workspaceId),
  )
  const description = localized(ruleSet.description, i18n.language)

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4 rounded-xl border bg-card p-5 pb-0 shadow-sm">
      <div className="flex items-center gap-2">
        <Info size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
      </div>

      {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}

      {!!ruleSet.badges?.length && <BadgeStrip badges={ruleSet.badges} />}

      {ruleSet.version && (
        <div className="flex">
          <Badge variant="outline" className="font-mono">v{ruleSet.version}</Badge>
        </div>
      )}

      {/* Author, organization, dates and licence, resolved the same way every
          card footer resolves them (live identity, frozen snapshot fallback).
          The card drops its bottom padding (`pb-0`) because CardMetaFooter
          carries its own pt-3/pb-2, and `-mt-1` trims the container's gap-4 —
          this row is fine print, not a section. */}
      <CardMetaFooter
        className="-mt-1"
        createdById={ruleSet.createdById}
        createdBy={ruleSet.createdBy}
        createdByDetails={ruleSet.createdByDetails}
        organizationId={ruleSet.organization ? undefined : workspace?.organizationId}
        organization={ruleSet.organization}
        createdAt={ruleSet.createdAt}
        updatedAt={ruleSet.updatedAt}
        license={ruleSet.license}
        showLicenseWhenEmpty
        onOpenLicense={onSeeLicense}
      />
    </div>
  )
}

function DqLicenseTab({ ruleSet }: { ruleSet: DqRuleSet }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const updateRuleSet = useDqStore((s) => s.updateRuleSet)
  // The rule set's own frozen provenance wins; otherwise the workspace's live
  // organization — the rule every other licence tab follows.
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === ruleSet.workspaceId))
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = ruleSet.organization?.name ?? org?.name

  return (
    <EntityLicensePanel
      license={ruleSet.license ?? null}
      onSave={(license) => updateRuleSet(ruleSet.id, { license: license ?? undefined })}
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

  // Export downloads a ZIP rather than opening a view, so it has no tab id and
  // never becomes the active one — it sits here because this is where the
  // occasional actions live.
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
