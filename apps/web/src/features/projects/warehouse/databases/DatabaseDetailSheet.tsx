import { useTranslation } from 'react-i18next'
import type { DataSource, DatabaseConnectionConfig, TableRowCount } from '@/types'
import { Users, Building2, Table, Activity, BedDouble } from 'lucide-react'
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
import { DatabaseStatsDashboard, useDatabaseStats } from './DatabaseStatsDashboard'

interface DatabaseDetailSheetProps {
  source: DataSource | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const statusColors: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

function formatSourceType(source: DataSource): string {
  if (source.sourceType === 'fhir') return 'FHIR Server'
  const mapping = source.schemaMapping
  if (mapping?.presetLabel) return mapping.presetLabel
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
          <SheetDescription>{formatSourceType(source)}</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="overview" className="flex flex-1 flex-col min-h-0">
          <div className="px-6 shrink-0">
            <TabsList variant="line">
              <TabsTrigger value="overview">
                {t('databases.detail_overview')}
              </TabsTrigger>
              {hasMappedSchema && (
                <TabsTrigger value="statistics">
                  {t('databases.detail_statistics')}
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <TabsContent value="overview" className="mt-0 px-6 pb-6">
              <OverviewTab source={source} formatDate={formatDate} />
            </TabsContent>

            {hasMappedSchema && source.schemaMapping && (
              <TabsContent value="statistics" className="mt-0 px-6 pb-6">
                <DatabaseStatsDashboard dataSourceId={source.id} schemaMapping={source.schemaMapping} sourceStatus={source.status} />
              </TabsContent>
            )}
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function OverviewTab({
  source,
  formatDate,
}: {
  source: DataSource
  formatDate: (iso: string) => string
}) {
  const { t } = useTranslation()
  const hasMappedSchema = !!source.schemaMapping?.patientTable

  return (
    <div className="space-y-6 pt-4">
      {/* Error banner */}
      {source.status === 'error' && source.errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p className="text-xs font-medium text-destructive">{t('databases.detail_error')}</p>
          <p className="mt-1 text-xs text-destructive/80 font-mono break-all">{source.errorMessage}</p>
        </div>
      )}

      {/* Connection info */}
      <Section title={t('databases.detail_connection')}>
        <InfoGrid>
          <InfoRow label="Type" value={formatSourceType(source)} />
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

      {/* Summary counts for mapped schemas */}
      {hasMappedSchema && source.schemaMapping && (
        <>
          <MappedSummaryCounts dataSourceId={source.id} schemaMapping={source.schemaMapping} sourceStatus={source.status} />
          <Separator />
        </>
      )}

      {/* Non-mapped stats */}
      {!hasMappedSchema && source.stats && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {source.stats.tableCount != null && (
              <MiniStatCard label={t('databases.detail_tables')} value={source.stats.tableCount} />
            )}
          </div>
          <Separator />
        </>
      )}

      {/* Table counts for mapped schemas */}
      {hasMappedSchema && source.schemaMapping && (
        <TableCountsSection dataSourceId={source.id} schemaMapping={source.schemaMapping} sourceStatus={source.status} />
      )}

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

/** Summary count cards using cached database stats. */
function MappedSummaryCounts({ dataSourceId, schemaMapping, sourceStatus }: { dataSourceId: string; schemaMapping: import('@/types').SchemaMapping; sourceStatus?: string }) {
  const { t } = useTranslation()
  const { cache, isLoading } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  return (
    <div className="grid grid-cols-2 gap-3">
      <StatCard
        icon={Table}
        label={t('databases.detail_tables')}
        value={cache?.summary.tableCount}
        loading={isLoading}
      />
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
    </div>
  )
}

/** Table counts section using cached database stats. */
function TableCountsSection({ dataSourceId, schemaMapping, sourceStatus }: { dataSourceId: string; schemaMapping: import('@/types').SchemaMapping; sourceStatus?: string }) {
  const { t } = useTranslation()
  const { cache, isLoading } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{t('databases.stats_table_overview')}</h3>
      {isLoading && !cache ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : cache ? (
        <TableCountsList data={cache.tableCounts} />
      ) : null}
      <Separator className="mt-6" />
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

function MiniStatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums">{value.toLocaleString()}</p>
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

function TableCountsList({ data }: { data: TableRowCount[] }) {
  return (
    <div className="space-y-1">
      {data.map(({ tableName, rowCount }) => (
        <div
          key={tableName}
          className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5"
        >
          <span className="text-xs font-mono">{tableName}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {rowCount.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
