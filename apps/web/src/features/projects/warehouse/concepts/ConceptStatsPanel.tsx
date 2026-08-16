import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { niceTicks, tightHistogramScale } from '@/lib/chart-ticks'
import type { ConceptStats, HistogramBin } from './use-concepts'

interface ConceptStatsPanelProps {
  hasValueColumn: boolean
  stats: ConceptStats | null
  isLoading: boolean
  excludeOutliers: boolean
  onExcludeOutliersChange: (value: boolean) => void
  /** False when the Stats checkbox is off — nothing is computed for any concept. */
  statsEnabled: boolean
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}

/** Compact axis labels — 1234567 → "1.2M", so long counts fit the narrow panel. */
function compactCount(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return v.toLocaleString()
}

function Histogram({ data, startAtZero }: { data: HistogramBin[]; startAtZero: boolean }) {
  // The SQL bins are anchored on the raw data minimum, so their edges are
  // arbitrary numbers like -27, 14, 56 — useless as axis labels. Lay a clean
  // linear grid over the value range and place bars at their real x value.
  // Checked → anchored at zero; unchecked → tightened on the real range (the
  // same pair the mapping editor's histogram uses).
  const xs = data.map((b) => b.bin_start)
  const scale = startAtZero ? niceTicks(xs, true) : tightHistogramScale(xs)
  const formatTick = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })

  // ~6px per character at fontSize 10, plus the tick mark and padding.
  const maxCount = Math.max(...data.map((b) => b.count), 0)
  const yLabelWidth = compactCount(maxCount).length * 6 + 12

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <XAxis
          // recharts caches the axis scale and ignores in-place domain/ticks
          // changes, so key it on the domain to force a fresh scale on toggle.
          key={scale ? `${scale.domain[0]}-${scale.domain[1]}` : 'auto'}
          type="number"
          dataKey="bin_start"
          domain={scale ? scale.domain : ['dataMin', 'dataMax']}
          ticks={scale?.ticks}
          tick={{ fontSize: 10 }}
          tickFormatter={formatTick}
        />
        {/* Compact labels + width sized to the widest one: a fixed width clipped
            counts like 1,234,567 to "1,23…". */}
        <YAxis
          tick={{ fontSize: 10 }}
          width={Math.max(28, yLabelWidth)}
          tickFormatter={compactCount}
        />
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

export function ConceptStatsPanel({
  hasValueColumn,
  stats,
  isLoading,
  excludeOutliers,
  onExcludeOutliersChange,
  statsEnabled,
}: ConceptStatsPanelProps) {
  const { t } = useTranslation()
  const [startAtZero, setStartAtZero] = useState(true)

  // Stats off: say so explicitly. Falling through would render "no records",
  // which reads as "this concept has none" rather than "nothing was computed".
  if (!statsEnabled) {
    return (
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>{t('concepts.stats_disabled')}</p>
        <p>{t('concepts.stats_disabled_hint')}</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-1.5">
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
    <div className="space-y-1.5">
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
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h4 className="text-xs font-medium">{t('concepts.stats_histogram')}</h4>
                <div className="flex items-center gap-3">
                  <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Checkbox
                      checked={excludeOutliers}
                      onCheckedChange={(v) => onExcludeOutliersChange(v === true)}
                      className="size-3.5"
                    />
                    {t('concepts.stats_exclude_outliers')}
                  </label>
                  <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Checkbox
                      checked={startAtZero}
                      onCheckedChange={(v) => setStartAtZero(v === true)}
                      className="size-3.5"
                    />
                    {t('concept_mapping.detail_starts_at_zero')}
                  </label>
                </div>
              </div>
              <Histogram data={stats.histogram} startAtZero={startAtZero} />
              {excludeOutliers && !!stats.histogram[0]?.excluded_count && (
                <p className="text-[10px] text-muted-foreground">
                  {t('concepts.stats_outliers_excluded', {
                    count: stats.histogram[0].excluded_count,
                  })}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
