import { useTranslation } from 'react-i18next'
import { Users, Table, Activity, BedDouble, Database as DatabaseIcon, ArrowLeft } from 'lucide-react'
import type { DataSource, DatabaseConnectionConfig, SchemaMapping } from '@/types'
import { localized } from '@/lib/localized'
import { useUrlTab } from '@/hooks/use-url-tab'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { BadgeStrip } from '@/components/ui/badge-strip'
import {
  DatabaseStatsDashboard,
  LoadStatisticsPrompt,
  useDatabaseStats,
} from './DatabaseStatsDashboard'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'

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
  const { t, i18n } = useTranslation()
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

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

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
                formatDate={formatDate}
                statsMapping={statsMapping}
                hasMappedSchema={hasMappedSchema}
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
  formatDate,
  statsMapping,
  hasMappedSchema,
}: {
  source: DataSource
  formatDate: (iso: string) => string
  statsMapping: SchemaMapping
  hasMappedSchema: boolean
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
          <InfoRow label={t('databases.field_identifier')} value={source.alias} />
          {source.version && <InfoRow label={t('common.version')} value={source.version} />}
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

      {!!source.badges?.length && (
        <>
          <Section title={t('common.badges')}>
            <BadgeStrip badges={source.badges} />
          </Section>
          <Separator />
        </>
      )}

      {/* Headline figures. The per-table breakdown deliberately lives in the
          Statistics tab only — showing it in both made the split arbitrary. */}
      <Section title={t('databases.detail_statistics')}>
        <SummaryCounts
          dataSourceId={source.id}
          schemaMapping={statsMapping}
          sourceStatus={source.status}
          hasMappedSchema={hasMappedSchema}
        />
      </Section>

      <Separator />

      <Section title="">
        <InfoGrid>
          <InfoRow label={t('databases.detail_created_at')} value={formatDate(source.createdAt)} />
          <InfoRow label={t('databases.detail_updated_at')} value={formatDate(source.updatedAt)} />
        </InfoGrid>
      </Section>
    </div>
  )
}

/** Headline figures for the Overview tab. Table count is always meaningful;
 *  the clinical figures need a data model, so without one they are replaced by
 *  a pointer to the Statistics tab rather than shown as a misleading zero. */
function SummaryCounts({
  dataSourceId,
  schemaMapping,
  sourceStatus,
  hasMappedSchema,
}: {
  dataSourceId: string
  schemaMapping: SchemaMapping
  sourceStatus?: string
  hasMappedSchema: boolean
}) {
  const { t } = useTranslation()
  const { cache, isLoading, refresh } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  // Nothing computed yet: an explicit trigger rather than a grid of zeros, so a
  // billion-row database is only scanned on request.
  if (!cache && !isLoading) {
    return <LoadStatisticsPrompt onLoad={refresh} />
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <StatCard
        icon={Table}
        label={t('databases.detail_tables')}
        value={cache?.summary.tableCount}
        loading={isLoading}
      />
      {hasMappedSchema ? (
        <>
          <StatCard
            icon={Users}
            label={t('databases.detail_patients')}
            value={cache?.summary.patientCount}
            loading={isLoading}
          />
          <StatCard
            icon={Activity}
            label={t('databases.detail_visits')}
            value={cache?.summary.visitCount}
            loading={isLoading}
          />
          <StatCard
            icon={BedDouble}
            label={t('databases.detail_visit_units')}
            value={cache?.summary.visitDetailCount}
            loading={isLoading}
          />
        </>
      ) : (
        <div className="rounded-lg border border-dashed p-4">
          <p className="text-xs text-muted-foreground">{t('databases.stats_no_data_model_short')}</p>
        </div>
      )}
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

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: number | undefined
  loading: boolean
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon size={14} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      {loading && value == null ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <p className="mt-2 text-2xl font-bold tabular-nums">{(value ?? 0).toLocaleString()}</p>
      )}
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
