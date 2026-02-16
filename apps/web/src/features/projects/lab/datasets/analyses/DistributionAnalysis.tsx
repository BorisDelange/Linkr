import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useDatasetStore } from '@/stores/dataset-store'
import { TypeBadge } from '../TypeBadge'
import type { DatasetAnalysis, DatasetColumn } from '@/types'

interface DistributionAnalysisProps {
  analysis: DatasetAnalysis
}

const HISTOGRAM_BINS = 15
const MAX_CATEGORIES = 20

// --- Helpers (shared logic with ColumnStatsPanel) ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function buildHistogram(sorted: number[], bins: number) {
  if (sorted.length === 0) return []
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  if (min === max) return [{ label: String(min), count: sorted.length, pct: 100 }]
  const step = (max - min) / bins
  const result: { label: string; count: number; pct: number }[] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * step
    const hi = i === bins - 1 ? max + 1 : min + (i + 1) * step
    const count = sorted.filter((v) => v >= lo && v < hi).length
    result.push({ label: `${lo.toFixed(1)}`, count, pct: (count / sorted.length) * 100 })
  }
  return result
}

interface ColumnDistribution {
  column: DatasetColumn
  isNumeric: boolean
  total: number
  nonNull: number
  // Numeric
  histogram?: { label: string; count: number; pct: number }[]
  mean?: number
  std?: number
  median?: number
  min?: number
  max?: number
  // Categorical
  categories?: { value: string; count: number; pct: number }[]
  truncated?: boolean
  totalCategories?: number
}

export function DistributionAnalysis({ analysis }: DistributionAnalysisProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = _dirtyVersion >= 0 ? getFileRows(analysis.datasetFileId) : []

  const distributions = useMemo((): ColumnDistribution[] => {
    if (columns.length === 0 || rows.length === 0) return []

    return columns.map((col) => {
      const values = rows.map((r) => r[col.id])
      const nonNullValues = values.filter((v) => v != null && v !== '')
      const total = values.length
      const nonNull = nonNullValues.length

      const numericValues = nonNullValues.map(Number).filter((n) => !isNaN(n))
      const isNumeric = col.type === 'number' || (numericValues.length > 0 && numericValues.length === nonNullValues.length)

      if (isNumeric && numericValues.length > 0) {
        const sorted = [...numericValues].sort((a, b) => a - b)
        const sum = sorted.reduce((a, b) => a + b, 0)
        const mean = sum / sorted.length
        const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length
        const std = Math.sqrt(variance)
        const histogram = buildHistogram(sorted, HISTOGRAM_BINS)

        return {
          column: col,
          isNumeric: true,
          total,
          nonNull,
          histogram,
          mean,
          std,
          median: percentile(sorted, 50),
          min: sorted[0],
          max: sorted[sorted.length - 1],
        }
      }

      // Categorical
      const counts = new Map<string, number>()
      for (const v of nonNullValues) {
        const key = String(v)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
      const truncated = entries.length > MAX_CATEGORIES
      const visible = entries.slice(0, MAX_CATEGORIES)

      return {
        column: col,
        isNumeric: false,
        total,
        nonNull,
        categories: visible.map(([value, count]) => ({ value, count, pct: (count / total) * 100 })),
        truncated,
        totalCategories: entries.length,
      }
    })
  }, [columns, rows, _dirtyVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.no_rows')}
      </div>
    )
  }

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  return (
    <div className="h-full overflow-auto p-4 space-y-6">
      {distributions.map((dist) => (
        <div key={dist.column.id} className="rounded-lg border p-3 space-y-2">
          {/* Column header */}
          <div className="flex items-center gap-2">
            <TypeBadge type={dist.column.type} />
            <h4 className="text-xs font-medium">{dist.column.name}</h4>
            <span className="text-[10px] text-muted-foreground ml-auto">
              n={dist.nonNull}
              {dist.total - dist.nonNull > 0 && (
                <>, {dist.total - dist.nonNull} {t('datasets.stats_missing').toLowerCase()}</>
              )}
            </span>
          </div>

          {/* Numeric: histogram + quick stats */}
          {dist.isNumeric && dist.histogram && dist.histogram.length > 1 && (
            <div className="space-y-2">
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={dist.histogram} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v: number) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 9 }} width={30} />
                  <Tooltip
                    formatter={(value) => [Number(value).toLocaleString(), 'Count']}
                    labelFormatter={(label) => Number(label).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Bar dataKey="count" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground">
                <span>{t('datasets.stats_mean')}: {fmt(dist.mean!)}</span>
                <span>SD: {fmt(dist.std!)}</span>
                <span>{t('datasets.stats_median')}: {fmt(dist.median!)}</span>
                <span>{t('datasets.stats_min')}: {fmt(dist.min!)}</span>
                <span>{t('datasets.stats_max')}: {fmt(dist.max!)}</span>
              </div>
            </div>
          )}

          {/* Numeric with single value */}
          {dist.isNumeric && dist.histogram && dist.histogram.length === 1 && (
            <div className="text-xs text-muted-foreground">
              {t('datasets.stats_all_same_value')}: {dist.histogram[0].label} (n={dist.histogram[0].count})
            </div>
          )}

          {/* Categorical: simple bar list */}
          {!dist.isNumeric && dist.categories && dist.categories.length > 0 && (
            <div className="space-y-1.5">
              {dist.categories.map((cat) => (
                <div key={cat.value}>
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-[10px] text-muted-foreground truncate flex-1" title={cat.value}>{cat.value}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{cat.count} ({cat.pct.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2.5 w-full rounded-sm bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-sm bg-primary/60"
                      style={{ width: `${(cat.count / (dist.categories![0]?.count || 1)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
              {dist.truncated && (
                <p className="text-[10px] text-muted-foreground italic">
                  {t('datasets.stats_categories_truncated', { shown: MAX_CATEGORIES, total: dist.totalCategories })}
                </p>
              )}
            </div>
          )}

          {/* No data */}
          {dist.nonNull === 0 && (
            <div className="text-xs text-muted-foreground italic">
              {t('datasets.stats_no_data')}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
