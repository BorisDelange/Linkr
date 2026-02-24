import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts'
import { cn } from '@/lib/utils'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

const COLOR_MAP: Record<string, { text: string; bg: string; accent: string; hex: string }> = {
  red: { text: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950/30', accent: 'border-red-200 dark:border-red-800', hex: '#dc2626' },
  rose: { text: 'text-rose-600', bg: 'bg-rose-50 dark:bg-rose-950/30', accent: 'border-rose-200 dark:border-rose-800', hex: '#e11d48' },
  amber: { text: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-950/30', accent: 'border-amber-200 dark:border-amber-800', hex: '#d97706' },
  green: { text: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950/30', accent: 'border-green-200 dark:border-green-800', hex: '#16a34a' },
  emerald: { text: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/30', accent: 'border-emerald-200 dark:border-emerald-800', hex: '#059669' },
  cyan: { text: 'text-cyan-600', bg: 'bg-cyan-50 dark:bg-cyan-950/30', accent: 'border-cyan-200 dark:border-cyan-800', hex: '#0891b2' },
  blue: { text: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/30', accent: 'border-blue-200 dark:border-blue-800', hex: '#2563eb' },
  indigo: { text: 'text-indigo-600', bg: 'bg-indigo-50 dark:bg-indigo-950/30', accent: 'border-indigo-200 dark:border-indigo-800', hex: '#4f46e5' },
  violet: { text: 'text-violet-600', bg: 'bg-violet-50 dark:bg-violet-950/30', accent: 'border-violet-200 dark:border-violet-800', hex: '#7c3aed' },
  slate: { text: 'text-slate-600', bg: 'bg-slate-50 dark:bg-slate-950/30', accent: 'border-slate-200 dark:border-slate-800', hex: '#475569' },
}

const DEFAULT_COLOR = COLOR_MAP.blue

// ---------------------------------------------------------------------------
// Aggregate functions
// ---------------------------------------------------------------------------

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantile(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

function computeAggregate(values: number[], fn: string): number | null {
  if (values.length === 0) return null
  switch (fn) {
    case 'mean': return values.reduce((s, v) => s + v, 0) / values.length
    case 'median': return median(values)
    case 'min': return Math.min(...values)
    case 'max': return Math.max(...values)
    case 'sum': return values.reduce((s, v) => s + v, 0)
    case 'count': return values.length
    case 'sd': return stddev(values)
    case 'q1': return quantile(values, 0.25)
    case 'q3': return quantile(values, 0.75)
    case 'iqr': return quantile(values, 0.75) - quantile(values, 0.25)
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatNumber(val: number): string {
  if (Number.isInteger(val) && Math.abs(val) < 1e6) return val.toLocaleString()
  if (Math.abs(val) >= 1e6) return val.toExponential(2)
  return val.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

const AGG_LABELS: Record<string, { en: string; fr: string }> = {
  mean: { en: 'Mean', fr: 'Moyenne' },
  median: { en: 'Median', fr: 'Médiane' },
  min: { en: 'Min', fr: 'Min' },
  max: { en: 'Max', fr: 'Max' },
  sum: { en: 'Sum', fr: 'Somme' },
  count: { en: 'Count', fr: 'Effectif' },
  sd: { en: 'Std dev', fr: 'Écart-type' },
  q1: { en: 'Q1 (25th)', fr: 'Q1 (25e)' },
  q3: { en: 'Q3 (75th)', fr: 'Q3 (75e)' },
  iqr: { en: 'IQR', fr: 'IQR' },
}

// ---------------------------------------------------------------------------
// Icon helper
// ---------------------------------------------------------------------------

function getLucideIcon(name: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[name]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

// ---------------------------------------------------------------------------
// Histogram helper
// ---------------------------------------------------------------------------

function buildHistogramData(values: number[], bins: number) {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ label: formatNumber(min), count: values.length }]
  const binWidth = (max - min) / bins
  const buckets = Array.from({ length: bins }, (_, i) => ({
    label: formatNumber(min + i * binWidth),
    count: 0,
  }))
  for (const v of values) {
    let idx = Math.floor((v - min) / binWidth)
    if (idx >= bins) idx = bins - 1
    buckets[idx].count++
  }
  return buckets
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KeyIndicatorComponent({ config, columns, rows, compact }: ComponentPluginProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'

  const columnId = config.column as string | undefined
  const aggregate = (config.aggregate as string) ?? 'mean'
  const customTitle = config.title as string | undefined
  const iconName = (config.icon as string) ?? 'Activity'
  const colorName = (config.color as string) ?? 'blue'
  const chartType = (config.chartType as string) ?? 'none'
  const chartBins = (config.chartBins as number) ?? 15

  const column = columns.find(c => c.id === columnId)
  const color = COLOR_MAP[colorName] ?? DEFAULT_COLOR
  const Icon = getLucideIcon(iconName)

  const { values, result, stats } = useMemo(() => {
    if (!column) return { values: [], result: null, stats: null }
    const vals: number[] = []
    for (const row of rows) {
      const raw = row[column.id]
      if (raw == null) continue
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!isNaN(num)) vals.push(num)
    }
    const res = computeAggregate(vals, aggregate)
    const n = vals.length
    const sd = n > 0 ? stddev(vals) : 0
    return { values: vals, result: res, stats: { n, sd } }
  }, [column, rows, aggregate])

  // Title: custom or column name + aggregate label
  const aggLabel = AGG_LABELS[aggregate]?.[lang] ?? aggregate
  const title = customTitle?.trim() || (column ? `${aggLabel} — ${column.name}` : aggLabel)

  if (!column) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.kpi_no_column')}
      </div>
    )
  }

  if (result === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.kpi_no_data')}
      </div>
    )
  }

  const content = (
    <>
      {/* Icon + title */}
      <div className="flex items-center gap-2 mb-1">
        <Icon size={compact ? 16 : 18} className={color.text} />
        <span className="text-xs font-medium text-muted-foreground truncate">{title}</span>
      </div>

      {/* Big number */}
      <div className={cn('font-bold tracking-tight mt-2', color.text, compact ? 'text-3xl' : 'text-4xl')}>
        {formatNumber(result)}
      </div>

      {/* Subtitle */}
      {stats && (
        <div className="mt-1.5 text-xs text-muted-foreground">
          n = {stats.n.toLocaleString()}
          {aggregate !== 'count' && aggregate !== 'sd' && (
            <> &middot; SD = {formatNumber(stats.sd)}</>
          )}
        </div>
      )}

      {/* Mini-chart */}
      {chartType !== 'none' && values.length > 0 && (
        <div className="mt-3">
          <MiniChart
            values={values}
            chartType={chartType}
            bins={chartBins}
            hexColor={color.hex}
            column={column}
            rows={rows}
          />
        </div>
      )}
    </>
  )

  // Compact mode: fill entire widget, no inner card border
  if (compact) {
    return (
      <div className={cn('flex h-full flex-col justify-center p-4', color.bg)}>
        {content}
      </div>
    )
  }

  // Standard mode (analysis panel): centered card with border
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className={cn('w-full max-w-sm rounded-xl border p-6', color.bg, color.accent)}>
        {content}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mini chart sub-component
// ---------------------------------------------------------------------------

interface MiniChartProps {
  values: number[]
  chartType: string
  bins: number
  hexColor: string
  column: { id: string; name: string; type: string }
  rows: Record<string, unknown>[]
}

const PIE_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab']

function MiniChart({ values, chartType, bins, hexColor, column, rows }: MiniChartProps) {
  const data = useMemo(() => {
    if (chartType === 'histogram') {
      return buildHistogramData(values, bins)
    }
    if (chartType === 'bar' || chartType === 'pie') {
      // Frequency counts of raw values (top 10)
      const counts = new Map<string, number>()
      for (const row of rows) {
        const raw = row[column.id]
        if (raw == null) continue
        const key = String(raw)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, value]) => ({ name, value }))
    }
    return []
  }, [values, chartType, bins, column.id, rows])

  if (data.length === 0) return null

  if (chartType === 'histogram') {
    return (
      <ResponsiveContainer width="100%" height={100}>
        <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <Bar dataKey="count" fill={hexColor} opacity={0.7} radius={[2, 2, 0, 0]} />
          <Tooltip
            contentStyle={{ fontSize: 10, padding: '4px 8px', background: 'rgba(0,0,0,.8)', border: 'none', borderRadius: 4, color: '#fff' }}
            labelStyle={{ fontSize: 10, color: '#fff' }}
            cursor={{ fill: 'rgba(255,255,255,.15)' }}
          />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={Math.max(80, data.length * 22)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 9 }} />
          <Bar dataKey="value" fill={hexColor} opacity={0.7} radius={[0, 2, 2, 0]} />
          <Tooltip
            contentStyle={{ fontSize: 10, padding: '4px 8px', background: 'rgba(0,0,0,.8)', border: 'none', borderRadius: 4, color: '#fff' }}
            cursor={{ fill: 'rgba(255,255,255,.15)' }}
          />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'pie') {
    return (
      <ResponsiveContainer width="100%" height={120}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={50}
            innerRadius={25}
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ fontSize: 10, padding: '4px 8px', background: 'rgba(0,0,0,.8)', border: 'none', borderRadius: 4, color: '#fff' }}
          />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  return null
}
