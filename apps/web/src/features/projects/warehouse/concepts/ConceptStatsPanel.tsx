import { useTranslation } from 'react-i18next'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import type { ConceptStats, HistogramBin } from './use-concepts'

interface ConceptStatsPanelProps {
  hasValueColumn: boolean
  stats: ConceptStats | null
  isLoading: boolean
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}

function Histogram({ data }: { data: HistogramBin[] }) {
  const chartData = data.map((bin) => ({
    label: bin.bin_start,
    count: bin.count,
  }))

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 })}
        />
        <YAxis tick={{ fontSize: 10 }} width={40} />
        <Tooltip
          formatter={(value) => [Number(value).toLocaleString(), 'Count']}
          labelFormatter={(label) => Number(label).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          contentStyle={{ fontSize: 11, background: 'var(--color-popover)', border: '1px solid var(--color-border)', color: 'var(--color-popover-foreground)' }}
        />
        <Bar dataKey="count" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ConceptStatsPanel({ hasValueColumn, stats, isLoading }: ConceptStatsPanelProps) {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-[180px] w-full" />
      </div>
    )
  }

  if (!stats) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('concepts.stats_no_records')}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium">{t('concepts.stats_title')}</h4>
      <StatRow label={t('concepts.stats_row_count')} value={stats.rowCount.toLocaleString()} />

      {hasValueColumn && stats.distribution && (
        <>
          <Separator />
          <h4 className="text-xs font-medium">{t('concepts.stats_value_distribution')}</h4>
          <StatRow label={t('concepts.stats_non_null')} value={stats.distribution.non_null_count.toLocaleString()} />
          <StatRow label={t('concepts.stats_min')} value={stats.distribution.min_val} />
          <StatRow label={t('concepts.stats_max')} value={stats.distribution.max_val} />
          <StatRow label={t('concepts.stats_mean')} value={stats.distribution.mean_val} />
          <StatRow label={t('concepts.stats_median')} value={stats.distribution.median_val} />
          <StatRow label={t('concepts.stats_std')} value={stats.distribution.std_val} />

          {stats.histogram && stats.histogram.length > 0 && (
            <>
              <Separator />
              <h4 className="text-xs font-medium">{t('concepts.stats_histogram')}</h4>
              <Histogram data={stats.histogram} />
            </>
          )}
        </>
      )}
    </div>
  )
}
