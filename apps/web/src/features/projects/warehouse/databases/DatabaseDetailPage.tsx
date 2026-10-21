import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  Activity,
  FolderOpen,
  ArrowUpRight,
  Pencil,
  BarChart3,
  BookOpen,
  BedDouble,
  FileSpreadsheet,
  Database as DatabaseIcon,
  FileText,
  Info,
  Table,
  Table2,
  SquareTerminal,
  Network,
  Users,
  UsersRound,
} from 'lucide-react'
import type { CustomSchemaPreset, DataSource, DatabaseConnectionConfig, DatabaseStatsCache, SchemaMapping } from '@/types'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { useSessionDismissal } from '@/hooks/use-session-dismissal'
import { useEverOpened } from '@/hooks/use-ever-opened'
import { useUrlTab } from '@/hooks/use-url-tab'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DatabaseMappingTab } from './DatabaseMappingTab'
import { EntitySecondaryTabsTrigger } from '@/components/ui/entity-secondary-tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { notifyDatabaseLocationChanged, useDatabaseLocation } from './use-database-location'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { DatabaseStatsDashboard } from './DatabaseStatsDashboard'
import { useDatabaseStats } from './use-database-stats'
import { StatsErrorBanner } from './stats-error-banner'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { ReadmeMarkdown } from '@/components/editor/MarkdownRenderer'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
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
import { DatabaseSqlTab } from './DatabaseSqlTab'
import { openInSqlConsole } from './sql-console-drafts'
import { DatabaseConceptsTab } from './DatabaseConceptsTab'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { EntityNotFound } from '@/components/layout/EntityNotFound'
import { isExternalEngine } from '@/lib/database-engines'
import { useFlightStatus } from './use-flight-status'
import { ConnectionStatusBanner } from './connection-status-banner'
import { ConnectionCard } from './DatabaseConnectionCard'
import { connectionBannerShown } from './connection-status'

const DATABASE_TAB_IDS = ['overview', 'statistics', 'concepts', 'schema', 'mapping', 'sql', 'cohorts', 'readme', 'license', 'versioning'] as const
type DatabaseTabId = (typeof DATABASE_TAB_IDS)[number]

/** What a project may open. `resolveTab` falls back to the default for anything
 *  outside this list, so a bookmarked `?tab=readme` lands on the overview rather
 *  than on an empty body. */
const PROJECT_TAB_IDS = ['overview', 'statistics', 'concepts', 'schema', 'mapping', 'sql'] as const

/** Stand-in for a source with no data model: every clinical table is unknown, so
 *  only the table row counts can be computed. */
const EMPTY_MAPPING: SchemaMapping = { formatVersion: 2, presetId: 'none', presetLabel: { en: '', fr: '' } }

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
  const { raw } = useResolvedParams()
  const dbActions = useDatabaseActions()
  const location = useDatabaseLocation(source)
  const canEditLocation = useMyWorkspaceRole().can('databases:write') && !readOnly
  const [editOpen, setEditOpen] = useState(false)
  const [flightDismissed, dismissFlight] = useSessionDismissal(`flight:${source?.id}`)
  const [noSchemaDismissed, dismissNoSchema] = useSessionDismissal(`no-schema:${source?.id}`)
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const loadDataSources = useDataSourceStore((s) => s.loadDataSources)
  // Reinstalling replaces the whole entity's content, so it takes the same role
  // the list page requires to delete it — and never from the project's read-only
  // view of a workspace database.
  const canReinstall = useMyWorkspaceRole().atLeast('owner') && !readOnly
  // The concept counts are a cache: shared for a file database (an edit), the
  // user's own for an external one — the server's `_cache_write_permission`.
  const flightStatus = useFlightStatus(source)
  const canCountConcepts = useMyWorkspaceRole().can('databases:write')
    || isExternalEngine((source?.connectionConfig as DatabaseConnectionConfig | undefined)?.engine)
  const [activeTab, setActiveTab] = useUrlTab<DatabaseTabId>({
    key: `database:${source?.id ?? 'none'}`,
    tabs: readOnly ? PROJECT_TAB_IDS : DATABASE_TAB_IDS,
    defaultTab: 'overview',
  })
  // A cohort's builder has its own route under the database, so it is linkable.
  // The other tabs are browsed without leaving it: the URL keeps the cohort, so
  // Cohorts finds it still open, with whatever was being edited in it.
  const onCohortRoute = !!cohortId && !readOnly
  const [overCohort, setOverCohort] = useState<{ cohortId: string; tab: DatabaseTabId } | null>(null)
  // Forgotten once the cohort is left, or reopening it would land on that tab.
  if (!onCohortRoute && overCohort) setOverCohort(null)
  const shownTab: DatabaseTabId = onCohortRoute
    ? (overCohort?.cohortId === cohortId ? overCohort.tab : 'cohorts')
    : activeTab
  const selectTab = (tab: DatabaseTabId) => {
    if (onCohortRoute && cohortId) setOverCohort({ cohortId, tab })
    else setActiveTab(tab)
  }

  // Set by the overview's Edit button so the Readme tab opens in edit mode.
  // Cleared on the way out, or reaching the tab through its own trigger later
  // would land in the editor unasked.
  const [readmeEditing, setReadmeEditing] = useState(false)
  // Cleared only once the Readme tab has actually been left. Checking
  // `shownTab !== 'readme'` during render would fire immediately instead:
  // setActiveTab writes the URL, so the tab is still the previous one on the
  // render right after the Edit click, and the flag died before it was read.
  const wasOnReadme = useRef(false)
  useEffect(() => {
    if (shownTab === 'readme') wasOnReadme.current = true
    else if (wasOnReadme.current) {
      wasOnReadme.current = false
      setReadmeEditing(false)
    }
  }, [shownTab])
  // Once opened, a tab's content stays mounted: the schema browser does not
  // re-introspect the database, the concept list keeps its page, filters and
  // selected concept's stats, the SQL console a result or a query still running,
  // and a cohort builder its edits.
  const schemaEverOpened = useEverOpened(shownTab === 'schema')
  const conceptsEverOpened = useEverOpened(shownTab === 'concepts')
  const sqlEverOpened = useEverOpened(shownTab === 'sql')
  const cohortsEverOpened = useEverOpened(shownTab === 'cohorts')

  // Opening a database refreshes the patient count its card shows — once per
  // opening, when it is reachable.
  const refreshPatientCount = useDataSourceStore((s) => s.refreshPatientCount)
  const connected = source?.status === 'connected'
  useEffect(() => {
    if (source?.id && connected) void refreshPatientCount(source.id, { force: true })
  }, [source?.id, connected, refreshPatientCount])

  // Opening a database checks its connection: a database dropped, a password
  // changed since the last check would otherwise read as working until a query
  // failed. In the background — no 'configuring' gating the tabs meanwhile —
  // once per opening, and not while a job sets it up.
  const retestDataSource = useDataSourceStore((s) => s.retestDataSource)
  const settingUp = source?.status === 'configuring'
  useEffect(() => {
    if (source?.id && !settingUp) void retestDataSource(source.id, { background: true }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening, not again when it ends set up
  }, [source?.id, retestDataSource])

  if (!source) {
    return (
      <EntityNotFound
        entityLabel={t('common.entity_database')}
        entityId={raw.dbId}
        onBack={onBack}
        backLabel={t('common.back_to_databases')}
      />
    )
  }

  const hasMappedSchema = !!source.schemaMapping?.patient
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
            <TabsTrigger value="concepts">
              <BookOpen size={14} />
              {t('databases.detail_concepts')}
            </TabsTrigger>
            <TabsTrigger value="schema">
              <Table2 size={14} />
              {t('databases.detail_schema')}
            </TabsTrigger>
            <TabsTrigger value="mapping">
              <Network size={14} />
              {t('schema_mapping.db_tab')}
            </TabsTrigger>
            <TabsTrigger value="sql">
              <SquareTerminal size={14} />
              {t('databases.detail_sql')}
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

        {/* Under the tab bar, so it reads the same from every tab. */}
        <ConnectionStatusBanner
          source={source}
          onEditConnection={canEditLocation ? () => setEditOpen(true) : undefined}
          className="mx-6 mb-3"
        />
        {/* Nothing in this page works until the files are found again. */}
        {location.missing && (
          <NoticeBanner
            tone="danger"
            className="mx-6 mb-3"
            title={t('databases.location_missing_title')}
            description={location.path
              ? t('databases.location_missing_path', { path: location.path })
              : t('databases.location_missing_description')}
            action={canEditLocation && (
              <Button size="sm" onClick={() => setEditOpen(true)}>
                <FolderOpen size={14} />
                {t('databases.location_missing_change')}
              </Button>
            )}
          />
        )}
        {flightStatus && flightStatus.status !== 'ok' && flightStatus.status !== 'not_applicable' && !flightDismissed && (
          <NoticeBanner
            tone="warning"
            className="mx-6 mb-3"
            onDismiss={dismissFlight}
            title={t('databases.flight_slow_title')}
            description={flightStatus.status === 'not_installed'
              ? t('databases.flight_not_installed')
              : t(flightStatus.status === 'unauthenticated' ? 'databases.flight_unauthenticated' : 'databases.flight_unreachable',
                  { port: flightStatus.port, detail: flightStatus.detail ?? '' })}
          />
        )}
        {/* Closable everywhere but on the Mapping tab, where the missing schema
            is the subject of the page. */}
        {!source.schemaMapping && (shownTab === 'mapping' || !noSchemaDismissed) && (
          <NoticeBanner
            tone="warning"
            className="mx-6 mb-3"
            onDismiss={shownTab === 'mapping' ? undefined : dismissNoSchema}
            title={t('databases.no_schema_title')}
            description={t('databases.no_schema_description')}
            action={canEditLocation && (
              <Button size="sm" onClick={() => setEditOpen(true)}>
                <Network size={14} />
                {t('databases.no_schema_assign')}
              </Button>
            )}
          />
        )}
        {editOpen && dbActions.renderEditDialog?.({
          item: source,
          initialTab: 'connection',
          onOpenChange: (open: boolean) => {
            setEditOpen(open)
            if (!open) notifyDatabaseLocationChanged(source.id)
          },
        })}

        {/* No outer ScrollArea: the overview is a fixed-height layout whose
            readme scrolls inside its own card. Letting the page scroll instead
            would give that card unbounded height and nothing would ever scroll. */}
        <TabsContent value="overview" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <OverviewTab
              source={source}
              statsMapping={statsMapping}
              hasMappedSchema={hasMappedSchema}
              onSeeStatistics={() => selectTab('statistics')}
              onEditReadme={readOnly ? undefined : () => { setReadmeEditing(true); selectTab('readme') }}
              onSeeLicense={readOnly ? undefined : () => selectTab('license')}
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

        <TabsContent
          value="concepts"
          forceMount
          className={`m-0 min-h-0 flex-1 p-0 ${shownTab === 'concepts' ? '' : 'hidden'}`}
        >
          {conceptsEverOpened && (
            <DatabaseConceptsTab
              dataSourceId={source.id}
              schemaMapping={statsMapping}
              readOnly={!canCountConcepts}
            />
          )}
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
          className={`m-0 min-h-0 flex-1 p-0 ${shownTab === 'schema' ? '' : 'hidden'}`}
        >
          {/* `configuring` counts as connected here. The browser calls
              testConnection when it mounts, and that sets `configuring` while it
              checks — which unmounted the browser, which stopped the check, which
              set `connected` again, which remounted the browser: the tab flickered
              between the placeholder and a half-listed schema, and text could not
              even be selected. A transient status is not a disconnection. */}
          {source.status === 'connected' || source.status === 'configuring' ? (
            schemaEverOpened && (
              <SchemaBrowser
                dataSourceId={source.id}
                onQueryRows={(sql) => {
                  openInSqlConsole(source.id, sql)
                  selectTab('sql')
                }}
              />
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <DatabaseIcon size={28} className="text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('databases.schema_needs_connection')}
              </p>
            </div>
          )}
        </TabsContent>
        {/* Read-only in a project, like the rest of the page: the override is
            the database's, edited where the database is managed. */}
        <TabsContent value="mapping" className="m-0 min-h-0 flex-1 overflow-auto p-0">
          <DatabaseMappingTab source={source} readOnly={readOnly} />
        </TabsContent>
        <TabsContent
          value="sql"
          forceMount
          className={`m-0 min-h-0 flex-1 p-0 ${shownTab === 'sql' ? '' : 'hidden'}`}
        >
          {source.status === 'connected' || source.status === 'configuring' ? (
            sqlEverOpened && <DatabaseSqlTab dataSourceId={source.id} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <DatabaseIcon size={28} className="text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">{t('databases.schema_needs_connection')}</p>
            </div>
          )}
        </TabsContent>

        {!readOnly && (
          <TabsContent
            value="cohorts"
            forceMount
            className={`m-0 min-h-0 flex-1 p-0 ${shownTab === 'cohorts' ? '' : 'hidden'}`}
          >
            {cohortsEverOpened && (
              <DatabaseCohortHost dataSourceId={source.id} siblingDatabaseIds={siblingIds}>
                <DatabaseCohortsTab sourceId={source.id} status={source.status} showBuilder={onCohortRoute} />
              </DatabaseCohortHost>
            )}
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
  // Mounted here rather than inside the cards: the "not computed yet" banner sits
  // above them as a sibling in this grid, and both need the same state. One
  // instance, so the cards keep reading the very numbers the banner speaks for.
  const { cache, isLoading: statsLoading, error: statsError, refresh: refreshStats, cacheLoaded } = useDatabaseStats(
    source.id, statsMapping, source.status,
  )
  // Shown above every tab by the page (ConnectionStatusBanner).
  const showStatusBanner = connectionBannerShown(source)
  // Cards show a dash rather than a zero (which would read as "empty"), so
  // without a word here the tab looked like a database with nothing in it.
  // Not while the status banner is up: a database that cannot connect has no
  // statistics to run, and saying so twice buries the reason that matters.
  // Only once the stored statistics have been looked up: before that the banner
  // flashed on every visit to a database that does have them.
  const [statsBannerDismissed, dismissStatsBanner] = useSessionDismissal(`stats-not-computed:${source.id}`)
  const showStatsBanner = cacheLoaded && !cache && !statsLoading && !showStatusBanner && !statsBannerDismissed
  // A failed computation says why in place of the "not computed" prompt, which
  // otherwise came back as if nothing had been tried.
  const showStatsError = statsError != null && !showStatusBanner

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
      BAND_ROWS[Number(showStatsBanner || showStatsError)],
    )}>
      {/* The counts below are COUNT(*) over what may be billions of rows, so
          server mode never runs them unasked — the cards then read "—" with
          nothing saying why, or that one click fixes it. */}
      {showStatsError ? (
        <StatsErrorBanner
          dataSourceId={source.id}
          error={statsError}
          onRetry={refreshStats}
          retrying={statsLoading}
          className="col-span-full"
        />
      ) : showStatsBanner && (
        <NoticeBanner
          tone="warning"
          className="col-span-full"
          onDismiss={dismissStatsBanner}
          title={t('databases.stats_not_computed')}
          description={t('databases.stats_not_computed_hint')}
          action={(
            <Button size="sm" onClick={() => { void refreshStats(); onSeeStatistics() }} disabled={statsLoading}>
              <BarChart3 size={14} />
              {t('databases.load_statistics')}
            </Button>
          )}
        />
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

