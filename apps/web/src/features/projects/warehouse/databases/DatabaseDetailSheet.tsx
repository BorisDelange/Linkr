import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataSource, DatabaseConnectionConfig, SchemaMapping } from '@/types'
import { Users, Table, Activity, BedDouble, Table2 } from 'lucide-react'
import { localized } from '@/lib/localized'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DatabaseStatsDashboard,
  LoadStatisticsPrompt,
  useDatabaseStats,
} from './DatabaseStatsDashboard'
import { SchemaBrowserDialog } from '@/features/warehouse/databases/SchemaBrowserDialog'

interface DatabaseDetailSheetProps {
  source: DataSource | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

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

export function DatabaseDetailSheet({
  source,
  open,
  onOpenChange,
}: DatabaseDetailSheetProps) {
  const { t, i18n } = useTranslation()

  if (!source) return null

  const hasMappedSchema = !!source.schemaMapping?.patientTable
  // Without a data model there are no patient/visit tables to count, but table
  // row counts still make sense — and that is where the refresh button lives.
  const statsMapping = source.schemaMapping ?? EMPTY_MAPPING

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full p-0 flex flex-col overflow-hidden">
        <SheetHeader className="px-6 pt-6 pb-0 shrink-0">
          <div className="flex items-center gap-3">
            <SheetTitle>{source.name}</SheetTitle>
            <div className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${statusColors[source.status] ?? statusColors.disconnected}`}
              />
              <span className="text-xs text-muted-foreground">
                {t(`databases.status_${source.status}`)}
              </span>
            </div>
          </div>
          <SheetDescription>{formatSourceType(source, i18n.language)}</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="overview" className="flex flex-1 flex-col min-h-0">
          <div className="px-6 shrink-0">
            {/* Cancels the list's p-[3px] + the trigger's px-2 so the tab labels
                line up with the section titles below ("Connection", …). */}
            <TabsList variant="line" className="-ml-[11px]">
              <TabsTrigger value="overview">
                {t('databases.detail_overview')}
              </TabsTrigger>
              <TabsTrigger value="statistics">
                {t('databases.detail_statistics')}
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <TabsContent value="overview" className="mt-0 px-6 pb-6">
              <OverviewTab
                source={source}
                formatDate={formatDate}
                statsMapping={statsMapping}
                hasMappedSchema={hasMappedSchema}
              />
            </TabsContent>

            <TabsContent value="statistics" className="mt-0 px-6 pb-6">
              <DatabaseStatsDashboard
                dataSourceId={source.id}
                schemaMapping={statsMapping}
                sourceStatus={source.status}
                hasMappedSchema={hasMappedSchema}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
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
  const [schemaOpen, setSchemaOpen] = useState(false)

  return (
    <div className="space-y-6 pt-4">
      {/* Error banner */}
      {source.status === 'error' && source.errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p className="text-xs font-medium text-destructive">{t('databases.detail_error')}</p>
          <p className="mt-1 text-xs text-destructive/80 font-mono break-all">{source.errorMessage}</p>
        </div>
      )}

      {/* Browse every table of this database — same viewer the ETL pipeline and
          the IDE use. Only meaningful once the source is connected. */}
      {source.status === 'connected' && (
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => setSchemaOpen(true)}
        >
          <Table2 size={14} />
          {t('etl.browse_schema')}
        </Button>
      )}

      <SchemaBrowserDialog
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        dataSourceId={source.id}
      />

      {/* Connection info */}
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

      {/* Description */}
      {source.description && (
        <>
          <Section title={t('databases.field_description')}>
            <p className="text-sm text-muted-foreground">{source.description}</p>
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

      {/* Timestamps */}
      <Section title="">
        <InfoGrid>
          <InfoRow
            label={t('databases.detail_created_at')}
            value={formatDate(source.createdAt)}
          />
          <InfoRow
            label={t('databases.detail_updated_at')}
            value={formatDate(source.updatedAt)}
          />
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
          <p className="text-xs text-muted-foreground">
            {t('databases.stats_no_data_model_short')}
          </p>
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
        <p className="mt-2 text-2xl font-bold tabular-nums">
          {(value ?? 0).toLocaleString()}
        </p>
      )}
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
