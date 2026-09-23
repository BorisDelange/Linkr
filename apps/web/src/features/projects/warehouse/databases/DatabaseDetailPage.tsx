import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { DB_ERROR_NO_DATA_ON_IMPORT } from '@/lib/entity-io'
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
  Minimize2,
  Plug,
  Table,
  Table2,
  Users,
  UsersRound,
} from 'lucide-react'
import type { CustomSchemaPreset, DataSource, DatabaseConnectionConfig, DatabaseStatsCache, SchemaMapping } from '@/types'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { useUrlTab } from '@/hooks/use-url-tab'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntitySecondaryTabsTrigger } from '@/components/ui/entity-secondary-tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { CopyablePath, ParquetFilesDialog } from '@/components/ui/parquet-files-dialog'
import { humanBytes } from '@/lib/format-helpers'
import { isServerMode } from '@/lib/api-client'
import {
  compactDatabase,
  fetchCompactStatus,
  fetchDatabaseConnectionInfo,
  type CompactStatus,
  type DatabaseConnectionInfo,
} from '@/lib/api/data-sources'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import {
  DatabaseStatsDashboard,
  useDatabaseStats,
} from './DatabaseStatsDashboard'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { ReadmeMarkdown } from '@/components/editor/MarkdownRenderer'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { makeReinstall } from '@/lib/entity-reinstall'
import {
} from '@/components/ui/dropdown-menu'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import { DatabasePull } from '@/components/versioning/DatabasePull'
import { DatabaseCohortHost } from '@/features/projects/warehouse/cohorts/cohort-host'
import { CohortList } from '@/features/projects/warehouse/cohorts/CohortListPage'
import { CohortBuilder } from '@/features/projects/warehouse/cohorts/CohortBuilderPage'
import { useDatabaseActions } from './use-database-actions'
import { DerivedFromCard } from './DerivedFromCard'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'

const DATABASE_TAB_IDS = ['overview', 'statistics', 'schema', 'cohorts', 'readme', 'license', 'versioning'] as const
type DatabaseTabId = (typeof DATABASE_TAB_IDS)[number]

/** What a project may open. `resolveTab` falls back to the default for anything
 *  outside this list, so a bookmarked `?tab=readme` lands on the overview rather
 *  than on an empty body. */
const PROJECT_TAB_IDS = ['overview', 'statistics', 'schema'] as const

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
  /**
   * Opened from a project, where a database is something the project *uses*
   * rather than owns. The readme, licence, export and versioning tabs — and the
   * overview's edit affordance — describe the database itself, so they stay on
   * the workspace page that owns it; a project only ever links or unlinks.
   */
  readOnly?: boolean
  /** The `:cohortId` of `…/databases/:dbId/cohorts/:cohortId`: the Cohorts tab
   *  then shows that cohort's builder instead of the list. */
  cohortId?: string
  /** The workspace's database ids — the links this page builds shorten its id
   *  against them, as the database list does. */
  siblingIds?: readonly string[]
}

/**
 * A database's detail page: Overview, Statistics, Schema.
 *
 * Was a right-hand sheet, which capped the schema browser at `sm:max-w-xl` and
 * left its three panes fighting for width. The name, and the readme/licence/
 * export actions, live in the global header badge like every other entity —
 * hence no title here, only the tabs.
 */
export function DatabaseDetailPage({ source, onBack, readOnly = false, cohortId, siblingIds = [] }: DatabaseDetailPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const dbActions = useDatabaseActions()
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const loadDataSources = useDataSourceStore((s) => s.loadDataSources)
  // Reinstalling replaces the whole entity's content, so it takes the same role
  // the list page requires to delete it — and never from the project's read-only
  // view of a workspace database.
  const canReinstall = useMyWorkspaceRole().atLeast('owner') && !readOnly
  const [activeTab, setActiveTab] = useUrlTab<DatabaseTabId>({
    key: `database:${source?.id ?? 'none'}`,
    tabs: readOnly ? PROJECT_TAB_IDS : DATABASE_TAB_IDS,
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

  // Opening a database refreshes the patient count its card shows — once per
  // opening, when it is reachable.
  const refreshPatientCount = useDataSourceStore((s) => s.refreshPatientCount)
  const connected = source?.status === 'connected'
  useEffect(() => {
    if (source?.id && connected) void refreshPatientCount(source.id, { force: true })
  }, [source?.id, connected, refreshPatientCount])

  // A cohort's builder has its own route under the database, so it is linkable.
  // Leaving it through another tab goes back to the database's own URL.
  const onCohortRoute = !!cohortId && !readOnly
  const shownTab: DatabaseTabId = onCohortRoute ? 'cohorts' : activeTab
  const selectTab = (tab: DatabaseTabId) => {
    if (!onCohortRoute || !source) return setActiveTab(tab)
    const base = paths.warehouseDatabase(wsUid ?? '', source.id, siblingIds)
    navigate(tab === 'overview' ? base : `${base}?tab=${tab}`)
  }

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
        value={shownTab}
        onValueChange={(v) => selectTab(v as DatabaseTabId)}
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
            {!readOnly && (
              <TabsTrigger value="cohorts">
                <UsersRound size={14} />
                {t('databases.detail_cohorts')}
              </TabsTrigger>
            )}
            {!readOnly && (
              <EntitySecondaryTabsTrigger
                activeTab={shownTab}
                onSelect={selectTab}
                onExport={() => void dbActions.onExport(source)}
              />
            )}
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
              onEditReadme={readOnly ? undefined : () => { setReadmeEditing(true); setActiveTab('readme') }}
              onSeeLicense={readOnly ? undefined : () => setActiveTab('license')}
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
          {/* `configuring` counts as connected here. The browser calls
              testConnection when it mounts, and that sets `configuring` while it
              checks — which unmounted the browser, which stopped the check, which
              set `connected` again, which remounted the browser: the tab flickered
              between the placeholder and a half-listed schema, and text could not
              even be selected. A transient status is not a disconnection. */}
          {source.status === 'connected' || source.status === 'configuring' ? (
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
        {!readOnly && (
          <TabsContent value="cohorts" className="m-0 min-h-0 flex-1 p-0">
            <DatabaseCohortHost dataSourceId={source.id} siblingDatabaseIds={siblingIds}>
              <DatabaseCohortsTab sourceId={source.id} status={source.status} showBuilder={onCohortRoute} />
            </DatabaseCohortHost>
          </TabsContent>
        )}

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
            {/* Export is a menu action, so no export UI here — the tab is the
                push/pull panel alone. */}
            <GitRepositoryTab
              gitRemote={source.gitRemoteConfig ?? null}
              onSave={(cfg) => updateDataSource(source.id, { gitRemoteConfig: cfg ?? undefined })}
              syncScope="databases"
              syncId={source.id}
              renderInlinePull={({ branch, remoteHead, onPulled }) => (
                <DatabasePull
                  sourceId={source.id}
                  branch={branch}
                  remoteHead={remoteHead}
                  onPulled={onPulled}
                />
              )}
              // A pull replaces the row and its files wholesale, behind the store
              // the page reads — without this the tabs keep describing the
              // database that was there before it.
              onAfterPull={() => {
                void loadDataSources()
                void useCohortStore.getState().loadCohorts()
                usePatientChartStore.setState({ loaded: false })
              }}
              onReinstall={canReinstall ? makeReinstall('databases', source, source.workspaceId) : undefined}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * The database's own cohorts: the list, or one cohort's builder. They run on
 * this database, so it is connected on arrival (a no-op in server mode, where
 * the server holds the connection).
 */
function DatabaseCohortsTab({ sourceId, status, showBuilder }: { sourceId: string; status: DataSource['status']; showBuilder: boolean }) {
  const testConnection = useDataSourceStore((s) => s.testConnection)
  useEffect(() => {
    if (status !== 'connected' && status !== 'configuring') void testConnection(sourceId)
  }, [sourceId, status, testConnection])
  return showBuilder ? <CohortBuilder /> : <CohortList />
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

/**
 * Confirm and run a compaction, reporting what it reclaimed.
 *
 * Behind a confirmation because it rewrites the database file: the data is
 * unchanged, but a large file takes minutes and needs room for a full second
 * copy while it runs.
 */
function CompactDatabaseDialog({
  open,
  onOpenChange,
  source,
  sizeBytes,
  onCompacted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: DataSource
  sizeBytes: number | null
  onCompacted: () => void
}) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<CompactStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const running = state?.status === 'running'
  const result = state?.status === 'done' ? state : null

  // Reopening mid-run rejoins the compaction in progress: the work is server-side,
  // so closing the dialog only hid it. 404 means none has run — the normal case.
  useEffect(() => {
    if (!open || state) return
    fetchCompactStatus(source.id)
      .then((s) => { if (s.status === 'running') setState(s) })
      .catch(() => {})
  }, [open, state, source.id])

  // Held in a ref so the polling effect does not list it as a dependency: the
  // parent passes an inline arrow, which is a new reference on every render and
  // would tear down and rebuild the interval after each poll.
  const onCompactedRef = useRef(onCompacted)
  useEffect(() => {
    onCompactedRef.current = onCompacted
  }, [onCompacted])

  // Poll while the copy runs. One second matches the rate the server samples the
  // file at, so a faster poll would just re-read the same number.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      fetchCompactStatus(source.id)
        .then((s) => {
          setState(s)
          // `running` goes false on this same update, so the effect tears the
          // interval down and this fires once rather than on every later poll.
          if (s.status === 'done') onCompactedRef.current()
          if (s.status === 'error') setError(s.error ?? 'error')
        })
        .catch(() => {})
    }, 1000)
    return () => clearInterval(id)
  }, [running, source.id])

  const run = () => {
    setStarting(true)
    setError(null)
    compactDatabase(source.id)
      .then(setState)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStarting(false))
  }

  const close = () => {
    onOpenChange(false)
    // Cleared after the dialog is gone, so the body does not flip back to the
    // confirmation text while it animates out.
    setTimeout(() => {
      setState(null)
      setError(null)
    }, 200)
  }

  const reclaimed = result ? result.sizeBefore - (result.sizeAfter ?? 0) : 0
  // Capped: dataSize is DuckDB's own estimate, and a copy that runs slightly past
  // it must not render a bar wider than its track.
  const percent =
    running && state && state.dataSize
      ? Math.min(100, Math.round((state.bytesWritten / state.dataSize) * 100))
      : null

  return (
    <AlertDialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('databases.compact_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            {result ? (
              <span className="block">
                {reclaimed > 0
                  ? t('databases.compact_done', {
                      freed: humanBytes(reclaimed, i18n.language),
                      size: humanBytes(result.sizeAfter ?? 0, i18n.language),
                    })
                  : t('databases.compact_done_nothing')}
              </span>
            ) : running ? (
              <span className="block space-y-2">
                <span className="block">{t('databases.compact_running')}</span>
                {/* Only when DuckDB gave a denominator. Without one there is no
                    honest bar to draw, so the bytes written stand alone. */}
                {percent != null && <Progress value={percent} />}
                <span className="block font-mono text-[10px]">
                  {state && state.dataSize
                    ? t('databases.compact_progress', {
                        written: humanBytes(state.bytesWritten, i18n.language),
                        total: humanBytes(state.dataSize, i18n.language),
                        percent: percent ?? 0,
                      })
                    : t('databases.compact_progress_unknown', {
                        written: humanBytes(state?.bytesWritten ?? 0, i18n.language),
                      })}
                </span>
              </span>
            ) : (
              <span className="block space-y-2">
                <span className="block">{t('databases.compact_explain')}</span>
                <span className="block">
                  {t('databases.compact_warning', {
                    size: sizeBytes != null ? humanBytes(sizeBytes, i18n.language) : '—',
                  })}
                </span>
                {error && <span className="block text-destructive">{error}</span>}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {result ? (
            <AlertDialogAction onClick={close}>{t('common.close')}</AlertDialogAction>
          ) : running ? (
            // The work is server-side and survives this dialog, so closing it is
            // safe: hiding the progress does not cancel the compaction.
            <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={starting}>{t('common.cancel')}</AlertDialogCancel>
              {/* Not AlertDialogAction: that closes the dialog on click, and the
                  run has to stay on screen to report its progress. */}
              <Button size="sm" onClick={run} disabled={starting} className="gap-1.5">
                {starting && <Loader2 size={14} className="animate-spin" />}
                {t('databases.compact_action')}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** How this database is reached: engine, host or files, and the DuckDB alias. */
function ConnectionCard({ source }: { source: DataSource }) {
  const { t, i18n } = useTranslation()
  const config = source.connectionConfig as DatabaseConnectionConfig
  const [connInfo, setConnInfo] = useState<DatabaseConnectionInfo | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [compactOpen, setCompactOpen] = useState(false)
  // A moved file keeps its id and status: re-read the location when it changes.
  const managedPath = config.managedPath

  // Where the data actually sits on the server, so it can be read from an
  // R/Python script outside Linkr. Server mode only: the browser build keeps its
  // data inside the WASM sandbox, where there is no path to give.
  //
  // Re-read on `status` too, not just on the row: rebuilding from the schema
  // creates the file this describes without changing the id, so everything the
  // server answered here — the path, the Parquet list, the blob size — was stale
  // the moment it succeeded, and File location kept reading empty.
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
  }, [source.id, source.status, managedPath])

  const parquetTables = connInfo?.kind === 'parquet-folder' ? connInfo.tables : []
  const filePath = connInfo?.kind === 'file' ? connInfo.path : null

  // Compaction rewrites the file, so it is offered only for a server-owned
  // ("managed") database: an uploaded blob is addressed by its hash, and
  // rewriting it would invalidate every reference to that sha.
  const canCompact = Boolean(config.managed) && connInfo?.kind === 'file' && connInfo.exists

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
            {/* Under the path, not beside it: a content-addressed blob path fills
                the row on its own, and appending anything to it pushed the size
                onto a wrapped line of its own anyway. */}
            {connInfo?.sizeBytes != null && (
              <p className="text-[10px] text-muted-foreground">
                {humanBytes(connInfo.sizeBytes, i18n.language)}
              </p>
            )}
            {connInfo?.blob && (
              <p className="text-[10px] text-muted-foreground/70">{t('etl.pipeline_db_blob_hint')}</p>
            )}
            {connInfo && !connInfo.exists && (
              <p className="text-[10px] text-amber-600 dark:text-amber-500">{t('etl.pipeline_db_missing')}</p>
            )}
            {canCompact && (
              <Button
                variant="outline"
                size="xs"
                className="mt-1"
                onClick={() => setCompactOpen(true)}
              >
                <Minimize2 size={12} />
                {t('databases.compact_action')}
              </Button>
            )}
          </div>
        )}
      </div>
      <ParquetFilesDialog open={filesOpen} onOpenChange={setFilesOpen} tables={parquetTables} />
      <CompactDatabaseDialog
        open={compactOpen}
        onOpenChange={setCompactOpen}
        source={source}
        sizeBytes={connInfo?.sizeBytes ?? null}
        onCompacted={() => {
          // Re-read rather than patching sizeBytes locally: the server is the
          // only thing that knows what the file now weighs.
          fetchDatabaseConnectionInfo(source.id)
            .then(setConnInfo)
            .catch(() => {})
        }}
      />
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

/**
 * Row template for the overview grid, by how many full-width banners sit above
 * the content: one `auto` track each, then the content row. Spelled out as whole
 * literals because Tailwind scans source text — a class assembled at runtime is
 * never generated.
 */
const BAND_ROWS = [
  'grid-rows-[auto_minmax(0,1fr)]',
  'grid-rows-[auto_auto_minmax(0,1fr)]',
  'grid-rows-[auto_auto_auto_minmax(0,1fr)]',
]

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
  /** Absent from a project: the readme and licence tabs are the workspace's. */
  onEditReadme?: () => void
  onSeeLicense?: () => void
}) {
  const { t, i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments('data-source', source.id, source.workspaceId)
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const rebuildFromSchema = useDataSourceStore((s) => s.rebuildFromSchema)
  const retestDataSource = useDataSourceStore((s) => s.retestDataSource)
  const [rebuilding, setRebuilding] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const [retesting, setRetesting] = useState(false)
  // Mounted here rather than inside the cards: the "not computed yet" banner sits
  // above them as a sibling in this grid, and both need the same state. One
  // instance, so the cards keep reading the very numbers the banner speaks for.
  const { cache, isLoading: statsLoading, refresh: refreshStats } = useDatabaseStats(
    source.id, statsMapping, source.status,
  )
  // A rebuildable database is one that is not working and still holds the DDL it
  // was built from. Not gated on `errorMessage`: a database imported before the
  // import recorded a reason (or by a path that never did) is disconnected and
  // silent, and gating the banner on the message made the ONLY action that can
  // fix it unreachable — the user had to delete the database and recreate it.
  const canRebuild = source.status !== 'connected' && !!source.schemaMapping?.ddl
  const showStatusBanner = source.status !== 'connected' && (!!source.errorMessage || canRebuild)
  // Cards show a dash rather than a zero (which would read as "empty"), so
  // without a word here the tab looked like a database with nothing in it.
  // Not while the status banner is up: a database that cannot connect has no
  // statistics to run, and saying so twice buries the reason that matters.
  const showStatsBanner = !cache && !statsLoading && !showStatusBanner

  const handleRetest = async () => {
    setRetesting(true)
    try {
      await retestDataSource(source.id)
    } finally {
      setRetesting(false)
    }
  }

  // Re-check a failed database when its page opens. `loadDataSources` already
  // sweeps every broken source, but only once per session: this covers the
  // database that broke — or was repaired outside the app, an ETL releasing its
  // file lock — after that sweep ran.
  //
  // Once per source id: `status` moving to 'configuring' during the test would
  // otherwise re-enter this on the next render.
  const autoRetested = useRef<string | null>(null)
  useEffect(() => {
    if (source.status !== 'error' || autoRetested.current === source.id) return
    autoRetested.current = source.id
    void handleRetest()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the source, not on the handler identity
  }, [source.id, source.status])

  const handleRebuild = async () => {
    setConfirmRebuild(false)
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
      // row. Each banner is another full-width child when shown, so a fixed
      // two-track template left it on an implicit row that `overflow-hidden`
      // then clipped — it rendered behind the cards instead of pushing them down.
      BAND_ROWS[Number(showStatusBanner) + Number(showStatsBanner)],
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* First, because it is the non-destructive way out and fixes every
                transient cause. The rebuild below is the last resort. */}
            <Button size="sm" variant="outline" onClick={handleRetest} disabled={retesting || rebuilding}>
              {retesting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {t('databases.test_connection_again')}
            </Button>
            {canWrite && canRebuild && (
              <>
                {/* Confirmed, never immediate: the rebuild drops whatever the file
                    holds, and a database that merely failed to connect may still
                    carry every row it was loaded with. */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmRebuild(true)}
                  disabled={rebuilding || retesting}
                >
                  {rebuilding && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  {t('databases.rebuild_from_schema')}
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  {t('databases.rebuild_from_schema_hint')}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('databases.rebuild_from_schema')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('databases.rebuild_from_schema_confirm', { name: localized(source.name, i18n.language) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleRebuild}
            >
              {t('databases.rebuild_from_schema_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The counts below are COUNT(*) over what may be billions of rows, so
          server mode never runs them unasked — the cards then read "—" with
          nothing saying why, or that one click fixes it. */}
      {showStatsBanner && (
        <div className="col-span-full shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {t('databases.stats_not_computed')}
          </p>
          <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-400/80">
            {t('databases.stats_not_computed_hint')}
          </p>
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={refreshStats} disabled={statsLoading}>
              <BarChart3 size={14} className="mr-1.5" />
              {t('databases.load_statistics')}
            </Button>
          </div>
        </div>
      )}

      <DatabaseStatCards
        cache={cache}
        isLoading={statsLoading}
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
      {/* Scrolls on its own when its cards outgrow the row; the README beside
          it keeps its height and scrolls inside. */}
      <div className="-mr-1 flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
        <IdentityCard source={source} onSeeLicense={onSeeLicense} />
        <DerivedFromCard source={source} />
        <SchemaCard source={source} />
        <ConnectionCard source={source} />
      </div>
    </div>
  )
}

/** Headline figures, as the project summary shows its own: cards, not a table. */
function DatabaseStatCards({
  cache,
  isLoading,
  hasMappedSchema,
  onSeeStatistics,
}: {
  cache: DatabaseStatsCache | null
  isLoading: boolean
  hasMappedSchema: boolean
  onSeeStatistics: () => void
}) {
  const { t } = useTranslation()

  // Nothing computed yet. The cards still render — with a dash, never a zero,
  // which would read as "this database is empty" — and clicking one opens the
  // Statistics tab, where the full breakdown lives. What the dash MEANS is said
  // by the banner the overview puts above these cards.
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
  /** Absent from a project, where the readme is the workspace's to edit. */
  onEdit?: () => void
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
        {onEdit && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onEdit}>
            <Pencil size={12} />
            {t('common.edit')}
          </Button>
        )}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-3">
        {readme.trim() ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReadmeMarkdown>{resolved}</ReadmeMarkdown>
          </div>
        ) : onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('databases.readme_empty_hint')}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">{t('databases.readme_empty')}</p>
        )}
      </div>
    </div>
  )
}

/** Who made this database, when, under what licence, and how it is tagged. */
function IdentityCard({ source, onSeeLicense }: { source: DataSource; onSeeLicense?: () => void }) {
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
