import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { DB_ERROR_NO_DATA_ON_IMPORT } from '@/lib/entity-io'
import ReactMarkdown from 'react-markdown'
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Pencil,
  BarChart3,
  BedDouble,
  FileSpreadsheet,
  Database as DatabaseIcon,
  FileText,
  Info,
  Loader2,
  Plug,
  Table,
  Table2,
  Users,
} from 'lucide-react'
import type { CustomSchemaPreset, DataSource, DatabaseConnectionConfig, SchemaMapping } from '@/types'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { useUrlTab } from '@/hooks/use-url-tab'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntitySecondaryTabsTrigger } from '@/components/ui/entity-secondary-tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { CopyablePath, ParquetFilesDialog } from '@/components/ui/parquet-files-dialog'
import { isServerMode } from '@/lib/api-client'
import { fetchDatabaseConnectionInfo, type DatabaseConnectionInfo } from '@/lib/api/data-sources'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import {
  DatabaseStatsDashboard,
  useDatabaseStats,
} from './DatabaseStatsDashboard'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import {
} from '@/components/ui/dropdown-menu'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import { useDatabaseActions } from './use-database-actions'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'

const DATABASE_TAB_IDS = ['overview', 'statistics', 'schema', 'readme', 'license', 'versioning'] as const
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
  const dbActions = useDatabaseActions()
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const [activeTab, setActiveTab] = useUrlTab<DatabaseTabId>({
    key: `database:${source?.id ?? 'none'}`,
    tabs: DATABASE_TAB_IDS,
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
        <div className="flex shrink-0 items-center px-6 py-3">
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
            <EntitySecondaryTabsTrigger
              activeTab={activeTab}
              onSelect={setActiveTab}
              onExport={() => void dbActions.onExport(source)}
            />
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
          <div className="flex h-full flex-col px-6 pb-1.5">
            <OverviewTab
              source={source}
              statsMapping={statsMapping}
              hasMappedSchema={hasMappedSchema}
              onSeeStatistics={() => setActiveTab('statistics')}
              onEditReadme={() => { setReadmeEditing(true); setActiveTab('readme') }}
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
          <div className="flex h-full flex-col px-6 pb-1.5">
            <DatabaseReadmeTab source={source} editing={readmeEditing} />
          </div>
        </TabsContent>

        <TabsContent value="license" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <DatabaseLicenseTab source={source} />
          </div>
        </TabsContent>

        <TabsContent value="versioning" className="m-0 min-h-0 flex-1 p-0">
          <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col px-6 py-6">
            {/* Git link only: there is no `data-source` GitScope yet, so no
                push/pull panel. Export is a menu action, so no export UI here. */}
            <GitRepositoryTab
              gitRemote={source.gitRemoteConfig ?? null}
              onSave={(cfg) => updateDataSource(source.id, { gitRemoteConfig: cfg ?? undefined })}
            />
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
  const [connInfo, setConnInfo] = useState<DatabaseConnectionInfo | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)

  // Where the data actually sits on the server, so it can be read from an
  // R/Python script outside Linkr. Server mode only: the browser build keeps its
  // data inside the WASM sandbox, where there is no path to give.
  useEffect(() => {
    if (!isServerMode()) {
      setConnInfo(null)
      return
    }
    let cancelled = false
    fetchDatabaseConnectionInfo(source.id)
      .then((r) => { if (!cancelled) setConnInfo(r) })
      .catch(() => { if (!cancelled) setConnInfo(null) })
    return () => { cancelled = true }
  }, [source.id])

  const parquetTables = connInfo?.kind === 'parquet-folder' ? connInfo.tables : []
  const filePath = connInfo?.kind === 'file' ? connInfo.path : null

  const rows: { label: string; value: string }[] = [
    { label: 'Type', value: formatSourceType(source, i18n.language) },
    ...(source.sourceType === 'database' && config.engine
      ? [{ label: t('databases.field_engine'), value: capitalize(config.engine) }]
      : []),
    // The server's own count wins when it answered: it counts the blobs actually
    // stored, where `config.fileNames` is whatever the import recorded.
    ...(parquetTables.length || config.fileNames?.length
      ? []
      : config.host
        ? [{
            label: t('databases.field_host'),
            value: `${config.host}${config.port ? `:${config.port}` : ''}${config.database ? `/${config.database}` : ''}`,
          }]
        : []),
    { label: t('databases.field_identifier'), value: source.alias },
  ]

  const fileCount = parquetTables.length || config.fileNames?.length || 0

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
        {fileCount > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="shrink-0 text-muted-foreground">{t('databases.parquet_files_label')}</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">
                {t('databases.parquet_files_count', { count: fileCount })}
              </span>
              {/* Only the server knows the paths; without them there is nothing
                  a dialog could show beyond the count already on this row.
                  Negative margin: even the smallest button is taller than a
                  text-xs line, and without it this one row sat lower than the
                  rest of the card. */}
              {parquetTables.length > 0 && (
                <Button
                  variant="outline"
                  size="xs"
                  className="-my-1"
                  onClick={() => setFilesOpen(true)}
                >
                  {t('common.show')}
                </Button>
              )}
            </div>
          </div>
        )}
        {/* A single-file source (DuckDB, SQLite) has one path, so it reads inline
            rather than behind a dialog. */}
        {filePath && (
          <div className="space-y-1 pt-0.5">
            <span className="block text-xs text-muted-foreground">{t('databases.file_location')}</span>
            <CopyablePath value={filePath} />
            {connInfo?.blob && (
              <p className="text-[10px] text-muted-foreground/70">{t('etl.pipeline_db_blob_hint')}</p>
            )}
            {connInfo && !connInfo.exists && (
              <p className="text-[10px] text-amber-600 dark:text-amber-500">{t('etl.pipeline_db_missing')}</p>
            )}
          </div>
        )}
      </div>
      <ParquetFilesDialog open={filesOpen} onOpenChange={setFilesOpen} tables={parquetTables} />
    </div>
  )
}

function DatabaseReadmeTab({ source, editing }: { source: DataSource; editing?: boolean }) {
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  return (
    <EntityReadmePanel
      // Remounted when arriving from the overview's Edit button, so the
      // editor picks up the requested mode — initialMode only applies on mount.
      key={editing ? 'edit' : 'view'}
      initialMode={editing ? 'edit' : 'view'}
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
  onEditReadme,
  onSeeLicense,
}: {
  source: DataSource
  statsMapping: SchemaMapping
  hasMappedSchema: boolean
  onSeeStatistics: () => void
  onEditReadme: () => void
  onSeeLicense: () => void
}) {
  const { t, i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments('data-source', source.id, source.workspaceId)
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const rebuildFromSchema = useDataSourceStore((s) => s.rebuildFromSchema)
  const [rebuilding, setRebuilding] = useState(false)
  // A rebuildable database is one that is not working and still holds the DDL it
  // was built from. Not gated on `errorMessage`: a database imported before the
  // import recorded a reason (or by a path that never did) is disconnected and
  // silent, and gating the banner on the message made the ONLY action that can
  // fix it unreachable — the user had to delete the database and recreate it.
  const canRebuild = source.status !== 'connected' && !!source.schemaMapping?.ddl
  const showStatusBanner = source.status !== 'connected' && (!!source.errorMessage || canRebuild)

  const handleRebuild = async () => {
    setRebuilding(true)
    try {
      await rebuildFromSchema(source.id)
    } catch {
      // The failure is already on the row as `errorMessage`, which the banner
      // above renders — rethrowing here would only add an unhandled rejection.
    } finally {
      setRebuilding(false)
    }
  }

  return (
    /* One grid for the whole tab, so the two columns line up across both rows:
       the stat cards stop where About starts, and the README's bottom edge
       meets the side column's. */
    <div className={cn(
      'grid h-full min-h-0 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_20rem]',
      // One `auto` track per full-width band above the content, then the content
      // row. The banner is a THIRD full-width child when shown, so a fixed
      // two-track template left it on an implicit row that `overflow-hidden`
      // then clipped — it rendered behind the cards instead of pushing them down.
      showStatusBanner
        ? 'grid-rows-[auto_auto_minmax(0,1fr)]'
        : 'grid-rows-[auto_minmax(0,1fr)]',
    )}>
      {/* Shown for any non-working state that carries a reason, not just 'error':
          a database left disconnected by a data-free import has something to say
          too, and gating this on 'error' alone made those states silent. */}
      {showStatusBanner && (
        <div className={`col-span-full shrink-0 rounded-lg border px-4 py-3 ${
          source.status === 'error'
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-amber-500/30 bg-amber-500/5'
        }`}>
          <p className={`text-xs font-medium ${source.status === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}>
            {t(source.status === 'error' ? 'databases.detail_error' : 'databases.detail_not_connected')}
          </p>
          <p className={`mt-1 break-all text-xs ${source.status === 'error' ? 'font-mono text-destructive/80' : 'text-amber-700/80 dark:text-amber-400/80'}`}>
            {!source.errorMessage || source.errorMessage === DB_ERROR_NO_DATA_ON_IMPORT
              ? t('databases.imported_without_data')
              : source.errorMessage}
          </p>
          {/* A database built from a schema carries its DDL but never its tables —
              the export leaves the DuckDB file behind on purpose. Offer the one
              action that can fix it, since creation was the only path that ever
              applied the DDL. */}
          {canWrite && canRebuild && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={handleRebuild} disabled={rebuilding}>
                {rebuilding && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                {t('databases.rebuild_from_schema')}
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {t('databases.rebuild_from_schema_hint')}
              </span>
            </div>
          )}
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
      <ReadmePreview
        readme={localized(source.readme, i18n.language)}
        resolveUrls={resolveAttachmentUrls}
        onEdit={onEditReadme}
      />
      <div className="flex min-h-0 flex-col gap-4">
        <IdentityCard source={source} onSeeLicense={onSeeLicense} />
        <SchemaCard source={source} />
        <ConnectionCard source={source} />
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
  const { cache, isLoading } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  // Nothing computed yet. The cards still render — with a dash, never a zero,
  // which would read as "this database is empty" — and clicking one opens the
  // Statistics tab, where the prompt that actually runs the COUNTs lives. That
  // prompt belongs there and only there: shown here it explained a tab the
  // reader was not on.
  const pending = !cache && !isLoading

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
    /* Spans the parent grid's two columns and repeats its track sizes, so the
       first three cards sit over the README and the last sits over the side
       column — the two column edges line up down the whole tab. */
    <div className="col-span-full grid shrink-0 grid-cols-2 gap-4 lg:grid-cols-[repeat(3,minmax(0,1fr))_20rem]">
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
                <div className="text-2xl font-bold tabular-nums">
                  {pending || c.value == null ? '—' : c.value.toLocaleString()}
                </div>
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
 * A database **copies** its mapping rather than referencing a preset, so the
 * schema it came from may not exist here at all — an imported database whose
 * schema repo nobody installed is the normal case, not an edge one. The card
 * therefore always names the schema (from `schemaSource.label`, or the copied
 * mapping's own label) and only becomes a link when that schema is actually
 * present: linking regardless produced a dead end on a page that looked
 * clickable.
 */
function SchemaCard({ source }: { source: DataSource }) {
  const { t, i18n } = useTranslation()
  const { wsUid } = useResolvedParams()
  const [presets, setPresets] = useState<CustomSchemaPreset[]>([])
  const mapping = source.schemaMapping
  const provenance = source.schemaSource

  // Guarded on wsUid: it resolves a prefix through the workspace store, so it is
  // undefined on a cold load and the old fallback read every workspace's presets.
  useEffect(() => {
    if (!wsUid) return
    let cancelled = false
    getStorage().schemaPresets.getByWorkspace(wsUid)
      .then((rows) => { if (!cancelled) setPresets(rows) })
      .catch(() => { if (!cancelled) setPresets([]) })
    return () => { cancelled = true }
  }, [wsUid])

  // Either half names the schema. Requiring `mapping.presetId` hid the card for
  // every database whose mapping came from a published schema repo: a preset's
  // own export drops presetId/presetLabel from the mapping (they are `entityId`
  // and `name` at its root), so a copy of one carries neither — and the card
  // vanished from a database that has a perfectly good `schemaSource`.
  const named = mapping?.presetId && mapping.presetId !== 'none'
  if (!named && !provenance?.lineageId) return null

  const label =
    localized(provenance?.label, i18n.language)
    || localized(mapping?.presetLabel, i18n.language)
    || mapping?.presetId
    || ''

  // Lineage is the identity that survives crossing instances, so it is tried
  // first. The copied mapping's `presetId` is only a LOCAL primary key — useless
  // for an imported database, but exactly right for one built here, which is
  // every database created before provenance was recorded.
  const installed =
    (provenance?.lineageId != null
      ? presets.find((p) => p.lineageId === provenance.lineageId)
      : undefined)
    ?? (named ? presets.find((p) => p.presetId === mapping.presetId) : undefined)

  const body = (
    <>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-950">
        <FileSpreadsheet size={16} className="text-teal-600 dark:text-teal-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {installed ? t('databases.schema_preset') : t('databases.schema_not_installed')}
        </div>
      </div>
    </>
  )

  const shell = 'flex shrink-0 items-center gap-3 rounded-xl border bg-card p-4 shadow-sm'
  if (!installed) return <div className={shell}>{body}</div>

  return (
    <Link
      to={paths.warehouseSchema(wsUid ?? '', installed.id ?? installed.presetId)}
      className={cn(shell, 'transition-colors hover:bg-accent')}
    >
      {body}
      <ArrowUpRight size={14} className="shrink-0 text-muted-foreground" />
    </Link>
  )
}

/** The README, as much of it as fits, with a way through to the whole thing. */
function ReadmePreview({
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
        stacked
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
