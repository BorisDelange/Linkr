import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { Database as DatabaseIcon, ArrowLeft } from 'lucide-react'
import type { DataSource, DatabaseConnectionConfig, SchemaMapping } from '@/types'
import { localized, setLocalized } from '@/lib/localized'
import { useUrlTab } from '@/hooks/use-url-tab'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DatabaseStatsDashboard,
  LoadStatisticsPrompt,
  useDatabaseStats,
} from './DatabaseStatsDashboard'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { ReadmeEditor } from '@/components/editor/ReadmeEditor'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'

const DATABASE_TAB_IDS = ['overview', 'statistics', 'schema'] as const
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
            <TabsTrigger value="overview">{t('databases.detail_overview')}</TabsTrigger>
            <TabsTrigger value="statistics">{t('databases.detail_statistics')}</TabsTrigger>
            <TabsTrigger value="schema">{t('databases.detail_schema')}</TabsTrigger>
          </TabsList>
          {/* Balances the spacer so the tabs sit centred, as on the Schemas page. */}
          <div className="flex flex-1 items-center justify-end gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${statusColors[source.status] ?? statusColors.disconnected}`}
            />
            <span className="text-xs text-muted-foreground">
              {t(`databases.status_${source.status}`)}
            </span>
          </div>
        </div>

        <TabsContent value="overview" className="m-0 min-h-0 flex-1 p-0">
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl px-6 pb-8">
              <OverviewTab
                source={source}
                statsMapping={statsMapping}
                hasMappedSchema={hasMappedSchema}
                onSeeStatistics={() => setActiveTab('statistics')}
              />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="statistics" className="m-0 min-h-0 flex-1 p-0">
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl px-6 pb-8">
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
            never give enough width to. */}
        <TabsContent value="schema" className="m-0 min-h-0 flex-1 p-0">
          {source.status === 'connected' ? (
            <SchemaBrowser dataSourceId={source.id} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <DatabaseIcon size={28} className="text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('databases.schema_needs_connection')}
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function OverviewTab({
  source,
  statsMapping,
  hasMappedSchema,
  onSeeStatistics,
}: {
  source: DataSource
  statsMapping: SchemaMapping
  hasMappedSchema: boolean
  onSeeStatistics: () => void
}) {
  const { t, i18n } = useTranslation()

  return (
    <div className="space-y-6 pt-4">
      {source.status === 'error' && source.errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p className="text-xs font-medium text-destructive">{t('databases.detail_error')}</p>
          <p className="mt-1 break-all font-mono text-xs text-destructive/80">{source.errorMessage}</p>
        </div>
      )}

      <Section title={t('databases.detail_connection')}>
        <InfoGrid>
          <InfoRow label="Type" value={formatSourceType(source, i18n.language)} />
          {source.sourceType === 'database' && (
            <InfoRow
              label={t('databases.field_engine')}
              value={capitalize((source.connectionConfig as DatabaseConnectionConfig).engine)}
            />
          )}
          {source.sourceType === 'database' && (() => {
            const config = source.connectionConfig as DatabaseConnectionConfig
            if (config.fileNames && config.fileNames.length > 0) {
              return (
                <InfoRow
                  label={t('databases.upload_files')}
                  value={`${config.fileNames.length} Parquet files`}
                />
              )
            }
            if (config.host) {
              return (
                <InfoRow
                  label={t('databases.field_host')}
                  value={`${config.host}${config.port ? `:${config.port}` : ''}${config.database ? `/${config.database}` : ''}`}
                />
              )
            }
            return null
          })()}
        </InfoGrid>
      </Section>

      <Separator />

      {localized(source.description, i18n.language) && (
        <>
          <Section title={t('databases.field_description')}>
            <p className="text-sm text-muted-foreground">
              {localized(source.description, i18n.language)}
            </p>
          </Section>
          <Separator />
        </>
      )}

      {/* Orders of magnitude, one line: enough to judge whether the database is
          worth opening. Every figure, chart and per-table count is one tab away,
          and repeating them here made the two tabs near-identical. */}
      <Section title="">
        <SummaryCounts
          dataSourceId={source.id}
          schemaMapping={statsMapping}
          sourceStatus={source.status}
          hasMappedSchema={hasMappedSchema}
          onSeeAll={onSeeStatistics}
        />
      </Section>

      {/* What a shared database is really documented by — the thing someone
          installing it from the catalog needs to read. It was editable from the
          actions menu but visible nowhere. */}
      <Separator />
      <Section title={t('common.readme')}>
        <DatabaseReadme source={source} />
      </Section>
    </div>
  )
}

/** The database's README, rendered — and editable in place for anyone allowed to. */
function DatabaseReadme({ source }: { source: DataSource }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const { resolveAttachmentUrls } = useReadmeAttachments('data-source', source.id, source.workspaceId)

  return (
    <ReadmeEditor
      className="flex flex-col"
      readme={localized(source.readme, i18n.language)}
      onSave={(content) => {
        void updateDataSource(source.id, {
          readme: setLocalized(source.readme ?? {}, i18n.language, content),
        })
      }}
      resolveUrls={resolveAttachmentUrls}
      canEdit={canWrite}
    />
  )
}

/**
 * Orders of magnitude on one line, with a way through to the real thing.
 *
 * This used to be four big cards repeating the Statistics tab's own figures,
 * which made the two tabs near-identical and answered nothing the other did
 * not. What an overview owes the reader is only "how big is this, roughly" —
 * the charts, the per-table counts and the refresh control stay one tab away.
 */
function SummaryCounts({
  dataSourceId,
  schemaMapping,
  sourceStatus,
  hasMappedSchema,
  onSeeAll,
}: {
  dataSourceId: string
  schemaMapping: SchemaMapping
  sourceStatus?: string
  hasMappedSchema: boolean
  onSeeAll: () => void
}) {
  const { t } = useTranslation()
  const { cache, isLoading, refresh } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  // Nothing computed yet: an explicit trigger rather than a row of zeros, so a
  // billion-row database is only scanned on request.
  if (!cache && !isLoading) {
    return <LoadStatisticsPrompt onLoad={refresh} />
  }

  if (isLoading && !cache) {
    return <Skeleton className="h-5 w-72" />
  }

  const figures = [
    { key: 'tables', value: cache?.summary.tableCount, label: t('databases.detail_tables') },
    ...(hasMappedSchema
      ? [
          { key: 'patients', value: cache?.summary.patientCount, label: t('databases.detail_patients') },
          { key: 'visits', value: cache?.summary.visitCount, label: t('databases.detail_visits') },
        ]
      : []),
  ]

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-sm">
        {figures.map((f, i) => (
          <span key={f.key}>
            {i > 0 && <span className="mx-2 text-muted-foreground/50">·</span>}
            <span className="font-medium tabular-nums">{(f.value ?? 0).toLocaleString()}</span>
            <span className="ml-1.5 text-muted-foreground">{f.label.toLowerCase()}</span>
          </span>
        ))}
      </p>
      <Button variant="link" size="sm" onClick={onSeeAll} className="h-auto gap-1 p-0 text-xs">
        {t('databases.detail_see_all_statistics')}
        <ArrowRight size={12} />
      </Button>
    </div>
  )
}

// --- Helpers ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      {title && <h3 className="mb-3 text-sm font-medium">{title}</h3>}
      {children}
    </div>
  )
}

function InfoGrid({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2">{children}</div>
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium">{value}</span>
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
