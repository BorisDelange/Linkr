import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useDatasetStore } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { fetchColumnStats } from '@/lib/api/datasets'
import { BarChart3 } from 'lucide-react'
import { TypeBadge } from './TypeBadge'
import { BoxPlot } from '@/components/charts/box-plot'
import { niceStep, niceTicks } from '@/lib/chart-ticks'

interface ColumnStatsPanelProps {
  fileId: string | null
  columnId: string | null
}

const MAX_CATEGORIES = 20
const HISTOGRAM_BINS = 15

// --- Stat helpers ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function computeNumericStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  const min = sorted[0]
  const max = sorted[n - 1]
  const median = percentile(sorted, 50)
  const q1 = percentile(sorted, 25)
  const q3 = percentile(sorted, 75)
  const iqr = q3 - q1

  return { min, max, mean, median, std, q1, q3, iqr, n, sorted }
}

/** A histogram bar: numeric bin low `x` (for a numeric axis with nice ticks),
 * a rounded string `label` (tooltip), the `count`, and its `pct`. */
interface HistBin { x: number; label: string; count: number; pct: number }

function roundBinLabel(lo: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return lo.toFixed(decimals)
}

function buildHistogram(sorted: number[], bins: number): HistBin[] {
  if (sorted.length === 0) return []
  const dataMin = sorted[0]
  const dataMax = sorted[sorted.length - 1]
  if (dataMin === dataMax) return [{ x: dataMin, label: String(dataMin), count: sorted.length, pct: 100 }]

  // "Nice bins": round the start and step to readable values so bars land on round ticks.
  const step = niceStep((dataMax - dataMin) / bins)
  const start = Math.floor(dataMin / step) * step
  const result: HistBin[] = []
  for (let lo = start; lo < dataMax; lo += step) {
    const isLast = lo + step >= dataMax
    const hi = lo + step
    const count = sorted.filter((v) => v >= lo && (isLast ? v <= hi : v < hi)).length
    result.push({ x: lo, label: roundBinLabel(lo, step), count, pct: (count / sorted.length) * 100 })
  }
  return result
}

/** Capitalize first letter and strip trailing dot (e.g. "janv. 2024" → "Janv 2024"). */
function capitalizeDate(s: string): string {
  return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/\.\s/g, ' ').replace(/\.$/, '')
}

function formatDateLabel(ts: number, locale: string): string {
  const d = new Date(ts)
  return capitalizeDate(d.toLocaleDateString(locale, { year: 'numeric', month: 'short' }))
}

function formatDateFull(ts: number, locale: string): string {
  const d = new Date(ts)
  return capitalizeDate(d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }))
}

function computeDateSpan(minTs: number, maxTs: number): string {
  const diffMs = maxTs - minTs
  const days = Math.round(diffMs / 86_400_000)
  if (days < 1) return '< 1 day'
  if (days < 31) return `${days}d`
  const months = Math.round(days / 30.44)
  if (months < 12) return `${months}mo`
  const years = Math.floor(months / 12)
  const rem = months % 12
  return rem > 0 ? `${years}y ${rem}mo` : `${years}y`
}

function buildDateHistogram(sortedTs: number[], bins: number, locale: string) {
  if (sortedTs.length === 0) return []
  const min = sortedTs[0]
  const max = sortedTs[sortedTs.length - 1]
  if (min === max) return [{ label: formatDateLabel(min, locale), count: sortedTs.length, pct: 100 }]
  const step = (max - min) / bins
  const result: { label: string; count: number; pct: number }[] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * step
    const hi = i === bins - 1 ? max + 1 : min + (i + 1) * step
    const count = sortedTs.filter((v) => v >= lo && v < hi).length
    result.push({
      label: formatDateLabel(lo, locale),
      count,
      pct: (count / sortedTs.length) * 100,
    })
  }
  return result
}

function buildCategoryDistribution(values: unknown[]) {
  const counts = new Map<string, number>()
  for (const v of values) {
    const key = String(v)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const total = values.length
  const entries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
  const truncated = entries.length > MAX_CATEGORIES
  const visible = entries.slice(0, MAX_CATEGORIES)
  return {
    items: visible.map(([value, count]) => ({ value, count, pct: (count / total) * 100 })),
    truncated,
    totalCategories: entries.length,
  }
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right tabular-nums truncate">{typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}</span>
    </div>
  )
}

// --- Server stats adapter ---

type PanelStats = ReturnType<typeof buildStatsFromServer>

/** Map the server's column_stats payload into the shape the render consumes,
 *  so the JSX below is identical for server and front-only modes. */
function buildStatsFromServer(s: Record<string, unknown>, locale: string) {
  const total = Number(s.count ?? 0)
  const nonNull = Number(s.nonNull ?? 0)
  const base = {
    total,
    nonNull,
    nullCount: Number(s.nullCount ?? total - nonNull),
    uniqueCount: Number(s.distinct ?? 0),
    isNumeric: false,
    numeric: null as null | Record<string, number>,
    histogram: [] as HistBin[],
    isDate: false,
    dateStats: null as null | { earliest: string; latest: string; span: string },
    dateHistogram: [] as { label: string; count: number; pct: number }[],
    categories: null as null | {
      items: { value: string; count: number; pct: number }[]
      truncated: boolean
      totalCategories: number
    },
  }

  if (s.kind === 'numeric') {
    base.isNumeric = true
    base.numeric = {
      min: Number(s.min), max: Number(s.max), mean: Number(s.mean),
      median: Number(s.median), std: Number(s.std ?? 0),
      q1: Number(s.q1), q3: Number(s.q3), iqr: Number(s.iqr ?? 0),
    }
    const bins = (s.histogram as { lo: number; count: number | null }[] | undefined) ?? []
    // Server bins are equal-width from the raw min/max; keep the numeric low `x`
    // (the axis uses niceTicks for evenly-spaced round ticks) plus a rounded label.
    const binStep = bins.length > 1 ? Number(bins[1].lo) - Number(bins[0].lo) : 1
    base.histogram = bins
      .filter((b) => b.count != null)
      .map((b) => ({ x: Number(b.lo), label: roundBinLabel(Number(b.lo), niceStep(binStep)), count: Number(b.count), pct: total ? (Number(b.count) / total) * 100 : 0 }))
  } else if (s.kind === 'date') {
    const min = s.min ? Date.parse(String(s.min)) : NaN
    const max = s.max ? Date.parse(String(s.max)) : NaN
    if (!isNaN(min)) {
      base.isDate = true
      base.dateStats = {
        earliest: formatDateFull(min, locale),
        latest: formatDateFull(max, locale),
        span: computeDateSpan(min, max),
      }
      const bins = (s.timeline as { lo: string; count: number }[] | undefined) ?? []
      base.dateHistogram = bins.map((b) => {
        const ts = Date.parse(b.lo)
        return { label: formatDateLabel(ts, locale), count: b.count, pct: nonNull ? (b.count / nonNull) * 100 : 0 }
      })
    }
  } else if (s.kind === 'category') {
    const items = (s.items as { value: string; count: number }[] | undefined) ?? []
    base.categories = {
      items: items.map((it) => ({
        value: it.value,
        count: it.count,
        pct: nonNull ? (it.count / nonNull) * 100 : 0,
      })),
      truncated: Boolean(s.truncated),
      totalCategories: Number(s.totalCategories ?? items.length),
    }
  }
  return base
}

// --- Component ---

export function ColumnStatsPanel({ fileId, columnId }: ColumnStatsPanelProps) {
  const { t, i18n } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()
  const locale = i18n.language
  const server = isServerMode()

  const file = fileId ? files.find((f) => f.id === fileId) : null
  const column = file?.columns?.find((c) => c.id === columnId)
  const rows = !server && fileId && _dirtyVersion >= 0 ? getFileRows(fileId) : []

  // Server mode: fetch aggregated stats for the selected column. Tag the result
  // with its column so we never render a previous column's stats while loading.
  const [serverStats, setServerStats] = useState<{ key: string; stats: PanelStats | null } | null>(null)
  useEffect(() => {
    if (!server || !fileId || !columnId) return
    let cancelled = false
    const key = `${fileId}:${columnId}`
    fetchColumnStats(fileId, columnId)
      .then((s) => { if (!cancelled) setServerStats({ key, stats: buildStatsFromServer(s, locale) }) })
      .catch(() => { if (!cancelled) setServerStats({ key, stats: null }) })
    return () => { cancelled = true }
  }, [server, fileId, columnId, locale])

  const localStats = useMemo(() => {
    if (server || !column || !columnId) return null

    const allValues = rows.map((r) => r[columnId])
    const nonNullValues = allValues.filter((v) => v != null && v !== '')
    const total = allValues.length
    const nonNull = nonNullValues.length
    const nullCount = total - nonNull
    const uniqueCount = new Set(nonNullValues.map(String)).size

    // Date detection (before numeric — date strings would fail Number() anyway)
    const dateTimestamps: number[] = []
    let isDate = column.type === 'date'
    if (!isDate && nonNullValues.length > 0) {
      let allDates = true
      for (const v of nonNullValues.slice(0, 100)) {
        const s = String(v).trim()
        const ts = Date.parse(s)
        if (isNaN(ts) || /^\d+$/.test(s)) { allDates = false; break }
      }
      if (allDates) isDate = true
    }

    let dateStats: { minTs: number; maxTs: number; span: string; earliest: string; latest: string } | null = null
    let dateHistogram: { label: string; count: number; pct: number }[] = []
    if (isDate && nonNullValues.length > 0) {
      for (const v of nonNullValues) {
        const ts = Date.parse(String(v).trim())
        if (!isNaN(ts)) dateTimestamps.push(ts)
      }
      if (dateTimestamps.length > 0) {
        const sortedTs = [...dateTimestamps].sort((a, b) => a - b)
        const minTs = sortedTs[0]
        const maxTs = sortedTs[sortedTs.length - 1]
        dateStats = {
          minTs,
          maxTs,
          span: computeDateSpan(minTs, maxTs),
          earliest: formatDateFull(minTs, locale),
          latest: formatDateFull(maxTs, locale),
        }
        dateHistogram = buildDateHistogram(sortedTs, HISTOGRAM_BINS, locale)
      }
    }

    const numericValues = nonNullValues.map(Number).filter((n) => !isNaN(n))
    const isNumeric = !isDate && (column.type === 'number' || (numericValues.length > 0 && numericValues.length === nonNullValues.length))

    let numeric = null
    let histogram: HistBin[] = []
    if (isNumeric && numericValues.length > 0) {
      numeric = computeNumericStats(numericValues)
      histogram = buildHistogram(numeric.sorted, HISTOGRAM_BINS)
    }

    let categories = null
    if (!isNumeric && !isDate && nonNullValues.length > 0) {
      categories = buildCategoryDistribution(nonNullValues)
    }

    return { total, nonNull, nullCount, uniqueCount, isNumeric, numeric, histogram, isDate, dateStats, dateHistogram, categories }
  }, [server, column, columnId, rows, _dirtyVersion, locale]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = server
    ? (serverStats?.key === `${fileId}:${columnId}` ? serverStats.stats : null)
    : localStats

  if (!fileId || !columnId || !column) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <BarChart3 size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('datasets.select_column_stats')}</p>
      </div>
    )
  }

  if (!stats) return null

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <TypeBadge type={column.type} />
          <h3 className="text-xs font-medium truncate">{column.name}</h3>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4 text-xs">
        {/* Completeness bar */}
        {stats.total > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('datasets.stats_completeness')}</span>
              <span className="tabular-nums">{((stats.nonNull / stats.total) * 100).toFixed(1)}%</span>
            </div>
            <div className="h-3 w-full rounded-sm bg-destructive/15 overflow-hidden">
              <div
                className="h-full rounded-sm bg-emerald-500/70 transition-all"
                style={{ width: `${(stats.nonNull / stats.total) * 100}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{stats.nonNull} {t('datasets.stats_non_null').toLowerCase()}</span>
              <span>{stats.nullCount} {t('datasets.stats_missing').toLowerCase()}</span>
            </div>
          </div>
        )}

        {/* Summary counts */}
        <div className="space-y-1 border-t pt-3">
          <StatRow label={t('datasets.stats_total')} value={stats.total} />
          <StatRow label={t('datasets.stats_unique')} value={stats.uniqueCount} />
        </div>

        {/* Numeric statistics */}
        {stats.isNumeric && stats.numeric && (
          <div className="space-y-1 border-t pt-3">
            <h4 className="font-medium text-muted-foreground mb-1.5">{t('datasets.stats_numeric')}</h4>
            <StatRow label={t('datasets.stats_mean')} value={stats.numeric.mean} />
            <StatRow label={t('datasets.stats_median')} value={stats.numeric.median} />
            <StatRow label={t('datasets.stats_std')} value={stats.numeric.std} />
            <StatRow label="IQR" value={stats.numeric.iqr} />
            <StatRow label={t('datasets.stats_min')} value={stats.numeric.min} />
            <StatRow label="Q1 (25%)" value={stats.numeric.q1} />
            <StatRow label="Q3 (75%)" value={stats.numeric.q3} />
            <StatRow label={t('datasets.stats_max')} value={stats.numeric.max} />
            <div className="pt-2">
              <BoxPlot
                min={stats.numeric.min}
                p25={stats.numeric.q1}
                median={stats.numeric.median}
                p75={stats.numeric.q3}
                max={stats.numeric.max}
                mean={stats.numeric.mean}
                height={44}
              />
            </div>
          </div>
        )}

        {/* Numeric histogram — numeric X axis with niceTicks (round, evenly-spaced
            ticks like the app's other charts). Each bar is plotted at its bin
            CENTER and the domain is pinned to the exact data edges [lo, hi], so no
            bar overflows past the Y axis; only round ticks inside that span show. */}
        {stats.isNumeric && stats.histogram.length > 1 && (() => {
          const lows = stats.histogram.map((b) => b.x)
          const step = lows.length > 1 ? lows[1] - lows[0] : 1
          const dataLo = lows[0]                       // first bin's left edge
          const hi = lows[lows.length - 1] + step      // last bin's right edge
          const data = stats.histogram.map((b) => ({ ...b, center: b.x + step / 2 }))
          // Round, evenly-spaced ticks. The domain starts at the first ROUND tick
          // at or below the data (niceTicks' domain[0]) — not 0 — so there's no big
          // empty gap on the left and no bar overflows. Keep ticks within the domain.
          const scale = niceTicks([dataLo, hi])
          const lo = scale ? Math.min(scale.domain[0], dataLo) : dataLo
          const ticks = scale?.ticks.filter((tk) => tk >= lo && tk <= hi)
          return (
            <div className="space-y-1 border-t pt-3">
              <h4 className="font-medium text-muted-foreground mb-1.5">{t('datasets.stats_distribution')}</h4>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }} barCategoryGap={0}>
                  <XAxis
                    dataKey="center"
                    type="number"
                    scale="linear"
                    domain={[lo, hi]}
                    ticks={ticks}
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v: number) => Number(v).toLocaleString()}
                  />
                  <YAxis tick={{ fontSize: 9 }} width={30} />
                  <Tooltip
                    formatter={(value) => [Number(value).toLocaleString(), t('datasets.stats_count')]}
                    labelFormatter={(label) => Number(label).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    contentStyle={{ fontSize: 11, background: 'var(--color-popover)', border: '1px solid var(--color-border)', color: 'var(--color-popover-foreground)' }}
                  />
                  <Bar dataKey="count" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )
        })()}

        {/* Temporal statistics */}
        {stats.isDate && stats.dateStats && (
          <div className="space-y-1 border-t pt-3">
            <h4 className="font-medium text-muted-foreground mb-1.5">{t('datasets.stats_temporal')}</h4>
            <StatRow label={t('datasets.stats_earliest')} value={stats.dateStats.earliest} />
            <StatRow label={t('datasets.stats_latest')} value={stats.dateStats.latest} />
            <StatRow label={t('datasets.stats_span')} value={stats.dateStats.span} />
          </div>
        )}

        {/* Temporal histogram */}
        {stats.isDate && stats.dateHistogram.length > 1 && (
          <div className="space-y-1 border-t pt-3">
            <h4 className="font-medium text-muted-foreground mb-1.5">{t('datasets.stats_timeline')}</h4>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={stats.dateHistogram} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9 }}
                  interval="preserveStartEnd"
                />
                <YAxis tick={{ fontSize: 9 }} width={30} />
                <Tooltip
                  formatter={(value) => [Number(value).toLocaleString(), 'Count']}
                  contentStyle={{ fontSize: 11, background: 'var(--color-popover)', border: '1px solid var(--color-border)', color: 'var(--color-popover-foreground)' }}
                />
                <Bar dataKey="count" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Category distribution (horizontal bar chart) */}
        {stats.categories && (
          <div className="space-y-1 border-t pt-3">
            <h4 className="font-medium text-muted-foreground mb-1.5">{t('datasets.stats_distribution')}</h4>
            <div className="space-y-1">
              {stats.categories.items.map((item) => (
                <div key={item.value} className="group">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-[10px] text-muted-foreground truncate flex-1" title={item.value}>{item.value}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{item.count} ({item.pct.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 w-full rounded-sm bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-sm bg-primary/60"
                      style={{ width: `${(item.count / (stats.categories!.items[0]?.count || 1)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {stats.categories.truncated && (
              <p className="text-[10px] text-muted-foreground italic mt-1">
                {t('datasets.stats_categories_truncated', { shown: MAX_CATEGORIES, total: stats.categories.totalCategories })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
