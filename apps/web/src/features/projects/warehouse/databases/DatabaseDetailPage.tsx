import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BedDouble,
  FileSpreadsheet,
  Database as DatabaseIcon,
  FileText,
  Info,
  Plug,
  Scale,
  Table,
  Table2,
  Users,
} from 'lucide-react'
import type { DataSource, DatabaseConnectionConfig, SchemaMapping } from '@/types'
import { localized } from '@/lib/localized'
import { useUrlTab } from '@/hooks/use-url-tab'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import {
  DatabaseStatsDashboard,
  LoadStatisticsPrompt,
  useDatabaseStats,
} from './DatabaseStatsDashboard'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'

const DATABASE_TAB_IDS = ['overview', 'statistics', 'schema', 'readme', 'license'] as const
type DatabaseTabId = (typeof DATABASE_TAB_IDS)[number]

/** Stand-in for a source with no data model: every clinical table is unknown, so
 *  only the table row counts can be computed. */
const EMPTY_MAPPING: SchemaMapping = { presetId: 'none', presetLabel: { en: '', fr: '' } }

const statusColors: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

function formatSourceType(source: DataSource, lang: string): string {
  if (source.sourceType === 'fhir') return 'FHIR Server'
  const mapping = source.schemaMapping
  if (mapping?.presetLabel) return localized(mapping.presetLabel, lang)
  const config = source.connectionConfig as DatabaseConnectionConfig
  return config.engine ? config.engine.charAt(0).toUpperCase() + config.engine.slice(1) : 'Database'
}

interface DatabaseDetailPageProps {
  source: DataSource | undefined
  onBack: () => void
}

/**
 * A database's detail page: Overview, Statistics, Schema.
 *
 * Was a right-hand sheet, which capped the schema browser at `sm:max-w-xl` and
 * left its three panes fighting for width. The name, and the readme/licence/
 * export actions, live in the global header badge like every other entity —
 * hence no title here, only the tabs.
 */
export function DatabaseDetailPage({ source, onBack }: DatabaseDetailPageProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useUrlTab<DatabaseTabId>({
    key: `database:${source?.id ?? 'none'}`,
    tabs: DATABASE_TAB_IDS,
    defaultTab: 'overview',
  })
  // Sticky latch: once the schema tab has been opened its browser stays mounted,
  // so leaving and coming back does not re-introspect the database. Adjusted
  // during render rather than in an effect (the documented pattern for state
  // derived from a prop change): an effect would mount the browser one render
  // late, after the tab is already visible.
  const [schemaEverOpened, setSchemaEverOpened] = useState(false)
  if (activeTab === 'schema' && !schemaEverOpened) setSchemaEverOpened(true)

  if (!source) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <DatabaseIcon size={32} className="text-muted-foreground/50" />
        <p className="mt-3 text-sm text-muted-foreground">{t('databases.not_found')}</p>
        <Button variant="outline" size="sm" onClick={onBack} className="mt-4 gap-1.5">
          <ArrowLeft size={14} />
          {t('common.back')}
        </Button>
      </div>
    )
  }

  const hasMappedSchema = !!source.schemaMapping?.patientTable
  // Without a data model there are no patient/visit tables to count, but table
  // row counts still make sense — and that is where the refresh button lives.
  const statsMapping = source.schemaMapping ?? EMPTY_MAPPING

  return (
    <div className="flex h-full flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as DatabaseTabId)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center px-6 pt-2">
          <div className="flex-1" />
          <TabsList>
            <TabsTrigger value="overview">
              <Info size={14} />
              {t('databases.detail_overview')}
            </TabsTrigger>
            <TabsTrigger value="statistics">
              <BarChart3 size={14} />
              {t('databases.detail_statistics')}
            </TabsTrigger>
            <TabsTrigger value="schema">
              <Table2 size={14} />
              {t('databases.detail_schema')}
            </TabsTrigger>
            <TabsTrigger value="readme">
              <FileText size={14} />
              {t('common.readme')}
            </TabsTrigger>
            <TabsTrigger value="license">
              <Scale size={14} />
              {t('license.title')}
            </TabsTrigger>
          </TabsList>
          {/* Balances the spacer so the tabs sit centred, as on the Schemas page.
              The status reads as one of the connection facts, so it lives in the
              Connection card rather than floating beside the tabs. */}
          <div className="flex-1" />
        </div>

        {/* No outer ScrollArea: the overview is a fixed-height layout whose
            readme scrolls inside its own card. Letting the page scroll instead
            would give that card unbounded height and nothing would ever scroll. */}
        <TabsContent value="overview" className="m-0 min-h-0 flex-1 p-0">
          <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
            <OverviewTab
              source={source}
              statsMapping={statsMapping}
              hasMappedSchema={hasMappedSchema}
              onSeeStatistics={() => setActiveTab('statistics')}
              onSeeReadme={() => setActiveTab('readme')}
              onSeeLicense={() => setActiveTab('license')}
            />
          </div>
        </TabsContent>

        <TabsContent value="statistics" className="m-0 min-h-0 flex-1 p-0">
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl px-6 pb-1.5">
              <DatabaseStatsDashboard
                dataSourceId={source.id}
                schemaMapping={statsMapping}
                sourceStatus={source.status}
                hasMappedSchema={hasMappedSchema}
              />
            </div>
          </ScrollArea>
        </TabsContent>

        {/* The browser fills the page: its three panes are what the sheet could
            never give enough width to.

            forceMount + hidden rather than Radix's unmount-on-leave: the browser
            introspects the database and holds the table list, the selected
            table's columns and their loaded stats, all of which would be thrown
            away and refetched on every visit to this tab. It is only mounted
            once the tab has been opened, so a visitor who never opens it pays
            nothing. Same latch MappingProjectPage uses for its editor. */}
        <TabsContent
          value="schema"
          forceMount
          className={`m-0 min-h-0 flex-1 p-0 ${activeTab === 'schema' ? '' : 'hidden'}`}
        >
          {source.status === 'connected' ? (
            schemaEverOpened && <SchemaBrowser dataSourceId={source.id} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <DatabaseIcon size={28} className="text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('databases.schema_needs_connection')}
              </p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="readme" className="m-0 min-h-0 flex-1 p-0">
          <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
            <DatabaseReadmeTab source={source} />
          </div>
        </TabsContent>

        <TabsContent value="license" className="m-0 min-h-0 flex-1 p-0">
          <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
            <DatabaseLicenseTab source={source} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** A label/value row whose value gets a tooltip only when it is actually cut. */
function ConnectionRow({ label, value }: { label: string; value: string }) {
  const { ref, overflows, triggerProps } = useOverflowTooltip<HTMLSpanElement>()
  const text = (
    <span ref={ref} className="min-w-0 truncate font-medium" {...triggerProps}>
      {value}
    </span>
  )
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {overflows ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>{text}</TooltipTrigger>
            <TooltipContent side="top" className="text-xs">{value}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : text}
    </div>
  )
}

/** How this database is reached: engine, host or files, and the DuckDB alias. */
function ConnectionCard({ source }: { source: DataSource }) {
  const { t, i18n } = useTranslation()
  const config = source.connectionConfig as DatabaseConnectionConfig
  const rows: { label: string; value: string }[] = [
    { label: 'Type', value: formatSourceType(source, i18n.language) },
    ...(source.sourceType === 'database' && config.engine
      ? [{ label: t('databases.field_engine'), value: capitalize(config.engine) }]
      : []),
    ...(config.fileNames?.length
      ? [{ label: t('databases.upload_files'), value: `${config.fileNames.length} Parquet files` }]
      : config.host
        ? [{
            label: t('databases.field_host'),
            value: `${config.host}${config.port ? `:${config.port}` : ''}${config.database ? `/${config.database}` : ''}`,
          }]
        : []),
    { label: t('databases.field_identifier'), value: source.alias },
  ]

  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Plug size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_connection')}</h3>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="shrink-0 text-muted-foreground">{t('databases.status')}</span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${statusColors[source.status] ?? statusColors.disconnected}`}
            />
            <span className="truncate font-medium">{t(`databases.status_${source.status}`)}</span>
          </span>
        </div>
        {rows.map((r) => (
          <ConnectionRow key={r.label} label={r.label} value={r.value} />
        ))}
      </div>
    </div>
  )
}

function DatabaseReadmeTab({ source }: { source: DataSource }) {
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  return (
    <EntityReadmePanel
      readme={source.readme}
      onSave={(readme) => updateDataSource(source.id, { readme })}
      canEdit={canWrite}
      attachmentOwner={{ type: 'data-source', id: source.id, workspaceId: source.workspaceId }}
      // The tab already says "Readme".
      showTitle={false}
    />
  )
}

function DatabaseLicenseTab({ source }: { source: DataSource }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  // The database's own frozen provenance wins; otherwise the workspace's live
  // organization — the rule the project licence tab already follows.
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === source.workspaceId))
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = source.organization?.name ?? org?.name

  return (
    <EntityLicensePanel
      license={source.license ?? null}
      onSave={(license) => updateDataSource(source.id, { license: license ?? undefined })}
      canEdit={canWrite}
      copyrightHolder={holder ? localized(holder, i18n.language) : undefined}
      showTitle={false}
    />
  )
}

function OverviewTab({
  source,
  statsMapping,
  hasMappedSchema,
  onSeeStatistics,
  onSeeReadme,
  onSeeLicense,
}: {
  source: DataSource
  statsMapping: SchemaMapping
  hasMappedSchema: boolean
  onSeeStatistics: () => void
  onSeeReadme: () => void
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments('data-source', source.id, source.workspaceId)

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden pt-4">
      {source.status === 'error' && source.errorMessage && (
        <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p className="text-xs font-medium text-destructive">{t('databases.detail_error')}</p>
          <p className="mt-1 break-all font-mono text-xs text-destructive/80">{source.errorMessage}</p>
        </div>
      )}

      <DatabaseStatCards
        dataSourceId={source.id}
        schemaMapping={statsMapping}
        sourceStatus={source.status}
        hasMappedSchema={hasMappedSchema}
        onSeeStatistics={onSeeStatistics}
      />

      {/* The README is what documents a shared database — the thing whoever
          installs it from the catalog reads first — so it gets the room, with
          the identity card beside it. */}
      {/* `items-start` on the second column only: the readme stretches to the
          full height and scrolls inside itself, while About and the schema card
          keep the height their content needs. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ReadmePreview
          readme={localized(source.readme, i18n.language)}
          resolveUrls={resolveAttachmentUrls}
          onViewFull={onSeeReadme}
        />
        <div className="flex flex-col gap-4 self-start">
          <IdentityCard source={source} onSeeLicense={onSeeLicense} />
          <SchemaCard source={source} />
          <ConnectionCard source={source} />
        </div>
      </div>
    </div>
  )
}

/** Headline figures, as the project summary shows its own: cards, not a table. */
function DatabaseStatCards({
  dataSourceId,
  schemaMapping,
  sourceStatus,
  hasMappedSchema,
  onSeeStatistics,
}: {
  dataSourceId: string
  schemaMapping: SchemaMapping
  sourceStatus?: string
  hasMappedSchema: boolean
  onSeeStatistics: () => void
}) {
  const { t } = useTranslation()
  const { cache, isLoading, refresh } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  // Nothing computed yet: an explicit trigger rather than a row of zeros, so a
  // billion-row database is only scanned on request.
  if (!cache && !isLoading) {
    return <div className="shrink-0"><LoadStatisticsPrompt onLoad={refresh} /></div>
  }

  const cards = [
    { key: 'tables', icon: <Table size={16} className="text-teal-600 dark:text-teal-400" />, value: cache?.summary.tableCount, label: t('databases.detail_tables') },
    ...(hasMappedSchema
      ? [
          { key: 'patients', icon: <Users size={16} className="text-teal-600 dark:text-teal-400" />, value: cache?.summary.patientCount, label: t('databases.detail_patients') },
          { key: 'visits', icon: <Activity size={16} className="text-teal-600 dark:text-teal-400" />, value: cache?.summary.visitCount, label: t('databases.detail_visits') },
          { key: 'visit-units', icon: <BedDouble size={16} className="text-teal-600 dark:text-teal-400" />, value: cache?.summary.visitDetailCount, label: t('databases.detail_visit_units') },
        ]
      : []),
  ]

  return (
    <div className="grid shrink-0 grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={onSeeStatistics}
          className="rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-accent"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-950">
              {c.icon}
            </div>
            <div className="min-w-0">
              {isLoading && c.value == null ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold tabular-nums">{(c.value ?? 0).toLocaleString()}</div>
              )}
              <div className="truncate text-xs text-muted-foreground">{c.label}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

/**
 * The data model this database was built on, linking to the schema itself.
 *
 * `presetId` names a workspace schema, so the label is a way in rather than a
 * dead string: it is how you go and read what the tables are supposed to be.
 */
function SchemaCard({ source }: { source: DataSource }) {
  const { t, i18n } = useTranslation()
  const { wsUid } = useResolvedParams()
  const mapping = source.schemaMapping
  if (!mapping?.presetId || mapping.presetId === 'none') return null

  const label = localized(mapping.presetLabel, i18n.language) || mapping.presetId

  return (
    <Link
      to={paths.warehouseSchema(wsUid ?? '', mapping.presetId)}
      className="flex shrink-0 items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-950">
        <FileSpreadsheet size={16} className="text-teal-600 dark:text-teal-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{t('databases.schema_preset')}</div>
      </div>
      <ArrowUpRight size={14} className="shrink-0 text-muted-foreground" />
    </Link>
  )
}

/** The README, as much of it as fits, with a way through to the whole thing. */
function ReadmePreview({
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
            {t('databases.readme_empty_hint')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Who made this database, when, under what licence, and how it is tagged. */
function IdentityCard({ source, onSeeLicense }: { source: DataSource; onSeeLicense: () => void }) {
  const { t } = useTranslation()
  const workspace = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === source.workspaceId),
  )

  return (
    <div className="flex shrink-0 flex-col gap-4 rounded-xl border bg-card p-5 pb-0 shadow-sm">
      <div className="flex items-center gap-2">
        <Info size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
      </div>

      {!!source.badges?.length && <BadgeStrip badges={source.badges} />}

      {source.version && (
        <div className="flex">
          <Badge variant="outline" className="font-mono">v{source.version}</Badge>
        </div>
      )}

      {/* Author, organization, dates and licence, resolved the same way every
          card footer resolves them (live identity, frozen snapshot fallback).
          Spaced like a database card's footer: the card drops its bottom padding
          (`pb-0`) because CardMetaFooter carries its own pt-3/pb-2, and `-mt-1`
          trims the container's gap-4 — this row is fine print, not a section. */}
      <CardMetaFooter
        className="-mt-1"
        createdById={source.createdById}
        createdBy={source.createdBy}
        createdByDetails={source.createdByDetails}
        organizationId={source.organization ? undefined : workspace?.organizationId}
        organization={source.organization}
        createdAt={source.createdAt}
        updatedAt={source.updatedAt}
        license={source.license}
        showLicenseWhenEmpty
        onOpenLicense={onSeeLicense}
      />
    </div>
  )
}

// --- Helpers ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
