import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ArrowDown, ArrowUp, Building2, Database, Loader2, RefreshCw, Table2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { SearchInput } from '@/components/ui/search-input'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { sortTableCounts, type TableSort, type TableSortKey } from './quality-diff'
import type { DatabaseStatsCache, DataSource, TableRowCount } from '@/types'

export function StatsColumn({
  label,
  ds,
  stats,
  error,
  busy = false,
  loading,
  accent,
  onRetry,
}: {
  label: string
  ds: DataSource | undefined
  stats: DatabaseStatsCache | null
  error?: string
  busy?: boolean
  loading: boolean
  accent: 'orange' | 'emerald'
  onRetry: () => void
}) {
  const { t, i18n } = useTranslation()
  const borderColor = accent === 'orange' ? 'border-orange-500/30' : 'border-emerald-500/30'
  const iconColor = accent === 'orange' ? 'text-orange-500' : 'text-emerald-500'

  if (!ds) {
    return (
      <div className={cn('rounded-lg border-2 p-4 text-center', borderColor)}>
        <Database size={20} className="mx-auto text-muted-foreground/30" />
        <p className="mt-2 text-xs text-muted-foreground">{t('etl.pipeline_no_db_selected')}</p>
      </div>
    )
  }

  return (
    <div className={cn('min-w-0 space-y-3 rounded-lg border-2 p-3', borderColor)}>
      <div className="flex min-w-0 items-center gap-2">
        <Database size={14} className={cn('shrink-0', iconColor)} />
        <span className="shrink-0 text-xs font-medium">{label}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">— {localized(ds.name, i18n.language)}</span>
      </div>

      {busy && <NoticeBanner tone="progress" title={t('etl.quality_stats_target_busy')} />}

      {!busy && loading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t('common.loading')}…
        </div>
      )}

      {/* Without this the card was a bare "Source — MIMIC-IV" and nothing else,
          which reads as a rendering fault rather than "not computed". */}
      {!busy && !loading && !stats && (
        <div className="space-y-2 py-1">
          {/* A missing data model is the specific reason nothing can be counted,
              and it says what to do about it. Otherwise the count ran and failed,
              and the database's own error is the only useful explanation. */}
          {!ds.schemaMapping ? (
            <p className="text-xs text-muted-foreground">{t('etl.quality_stats_no_model')}</p>
          ) : (
            <QueryErrorNotice text={t('etl.quality_stats_unavailable')} error={error} onRetry={onRetry} />
          )}
        </div>
      )}

      {!busy && stats && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <StatBox icon={<Users size={16} className="text-blue-500" />} value={stats.summary.patientCount} label={t('etl.sidebar_patients')} />
            <StatBox icon={<Activity size={16} className="text-emerald-500" />} value={stats.summary.visitCount} label={t('etl.sidebar_visits')} />
            <StatBox icon={<Building2 size={16} className="text-amber-500" />} value={stats.summary.visitDetailCount} label={t('etl.sidebar_visit_units')} />
          </div>

          {stats.tableCounts.length > 0 && <TableCountList counts={stats.tableCounts} />}
        </div>
      )}
    </div>
  )
}

/**
 * The per-table row counts, searchable and sortable.
 *
 * A full OMOP target runs to dozens of tables in export order, so finding one
 * meant reading the whole list, and "which table is biggest" was not answerable
 * at all. Sorting is local to each column (source and target are independent
 * lists, and comparing them is the Concepts view's job, not this one's).
 */
function TableCountList({ counts }: { counts: TableRowCount[] }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<TableSort>({ by: 'rows', desc: true })

  const shown = useMemo(() => sortTableCounts(counts, search, sort), [counts, search, sort])

  const toggle = (by: TableSortKey) => {
    // Re-clicking the active column flips it; a new column starts in the
    // direction that column is usually read — A→Z for names, biggest first
    // for counts.
    setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by === 'rows' }))
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <SectionLabel as="h4" className="shrink-0">
          {t('etl.sidebar_tables')} ({shown.length === counts.length ? counts.length : `${shown.length}/${counts.length}`})
        </SectionLabel>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('etl.quality_stats_search_tables')}
          size="dense"
          className="ml-auto min-w-0 flex-1"
        />
      </div>

      <div className="flex items-center gap-2 border-b px-1 pb-1">
        <SortHeader label={t('etl.quality_stats_table_name')} active={sort.by === 'name'} desc={sort.desc} onClick={() => toggle('name')} className="min-w-0 flex-1" />
        <SortHeader label={t('etl.quality_stats_table_rows')} active={sort.by === 'rows'} desc={sort.desc} onClick={() => toggle('rows')} className="shrink-0" />
      </div>

      {shown.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">{t('etl.quality_stats_no_table_match')}</p>
      ) : (
        <div className="space-y-0.5">
          {shown.map((tc) => (
            <div key={tc.tableName} className="flex items-center gap-2 rounded px-1 py-1 text-xs">
              <Table2 size={11} className="shrink-0 text-blue-500/60" />
              <span className="min-w-0 flex-1 truncate font-mono">{tc.tableName}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{tc.rowCount.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SortHeader({
  label,
  active,
  desc,
  onClick,
  className,
}: {
  label: string
  active: boolean
  desc: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
      className={cn(
        'flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      {active && (desc ? <ArrowDown size={10} className="shrink-0" /> : <ArrowUp size={10} className="shrink-0" />)}
    </button>
  )
}

/** Sized for THIS tab, which is full width — the pipeline sidebar's 300px forced
 *  the 9px labels these started from, and they were barely legible here. */
function StatBox({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <div className="mx-auto mb-1 flex justify-center">{icon}</div>
      <div className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

/** A query that failed: what could not be read, the database's own error, and a retry. */
export function QueryErrorNotice({ text, error, onRetry }: { text: string; error?: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <NoticeBanner
      tone="warning"
      title={text}
      description={error && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted px-2 py-1.5 font-mono text-[10px]">
          {error}
        </pre>
      )}
      action={(
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw size={12} />
          {t('etl.quality_retry')}
        </Button>
      )}
    />
  )
}
