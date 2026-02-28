import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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
import { resolveColor, getLucideIcon, TOOLTIP_STYLE, aggregateByEntity } from '@/lib/plugins/shared-styles'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

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

function formatNumber(val: number, decimals?: number): string {
  if (decimals !== undefined) {
    if (Math.abs(val) >= 1e6) return val.toExponential(decimals)
    return val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  }
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
  proportion: { en: 'Proportion', fr: 'Proportion' },
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
  const uniquePerId = config.uniquePer as string | undefined
  const uniqueAggregation = (config.uniqueAggregation as string) ?? 'first'
  const aggregate = (config.aggregate as string) ?? 'mean'
  const targetValue = (config.targetValue as string | undefined) ?? ''
  const customTitle = config.title as string | undefined
  const centerTitle = (config.centerTitle as boolean) ?? false
  const iconName = (config.icon as string) ?? 'Activity'
  const colorName = (config.color as string) ?? 'blue'
  const chartType = (config.chartType as string) ?? 'none'
  const chartBins = (config.chartBins as number) ?? 15
  const showXAxis = (config.showXAxis as boolean) ?? false
  const chartPosition = (config.chartPosition as string) ?? 'below'
  const chartColors = (config.chartColors as string) ?? 'mono'
  const decimals = (config.decimals as number | undefined) ?? 1
  const unit = (config.unit as string | undefined) ?? ''
  const subtitleStats = (config.subtitleStats as string[] | undefined) ?? ['n']

  const isProportion = aggregate === 'proportion'

  const column = columns.find(c => c.id === columnId)
  const color = resolveColor(colorName)
  const Icon = getLucideIcon(iconName)

  // Aggregate rows per entity if uniquePer is set
  const sourceRows = useMemo(() => {
    if (!uniquePerId) return rows
    return aggregateByEntity(rows, uniquePerId, uniqueAggregation)
  }, [rows, uniquePerId, uniqueAggregation])

  // For proportion mode: compute proportion of target value
  const proportionResult = useMemo(() => {
    if (!isProportion || !column) return null
    const rawValues: unknown[] = []
    for (const row of sourceRows) {
      const raw = row[column.id]
      if (raw != null) rawValues.push(raw)
    }
    if (rawValues.length === 0) return null

    // Resolve target: use configured value, or auto-detect most frequent
    let resolvedTarget = targetValue
    if (!resolvedTarget) {
      const counts = new Map<string, number>()
      for (const v of rawValues) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
      let maxCount = 0
      for (const [k, c] of counts) {
        if (c > maxCount) { maxCount = c; resolvedTarget = k }
      }
    }

    const total = rawValues.length
    const matchCount = rawValues.filter(v => String(v) === resolvedTarget).length
    const pct = (matchCount / total) * 100

    return { result: pct, n: total, matchCount, resolvedTarget }
  }, [isProportion, column, sourceRows, targetValue])

  // For numeric mode: compute numeric aggregate + all stats
  const numericResult = useMemo(() => {
    if (isProportion || !column) return null
    const vals: number[] = []
    for (const row of sourceRows) {
      const raw = row[column.id]
      if (raw == null) continue
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!isNaN(num)) vals.push(num)
    }
    const res = computeAggregate(vals, aggregate)
    const stats: Record<string, number | null> = {
      n: vals.length,
      mean: computeAggregate(vals, 'mean'),
      median: computeAggregate(vals, 'median'),
      sd: vals.length > 0 ? stddev(vals) : null,
      min: computeAggregate(vals, 'min'),
      max: computeAggregate(vals, 'max'),
      q1: computeAggregate(vals, 'q1'),
      q3: computeAggregate(vals, 'q3'),
      iqr: computeAggregate(vals, 'iqr'),
    }
    return { values: vals, result: res, allStats: stats }
  }, [isProportion, column, sourceRows, aggregate])

  // Unified result
  const result = isProportion ? proportionResult?.result ?? null : numericResult?.result ?? null
  const values = numericResult?.values ?? []

  // Build subtitle parts
  const subtitleParts = useMemo(() => {
    if (isProportion) {
      if (!proportionResult) return []
      const parts: string[] = []
      if (subtitleStats.includes('n')) parts.push(`n = ${proportionResult.n.toLocaleString()}`)
      if (subtitleStats.includes('count')) parts.push(`${proportionResult.resolvedTarget} = ${proportionResult.matchCount.toLocaleString()}`)
      return parts
    }
    const allStats = numericResult?.allStats
    if (!allStats) return []
    const STAT_LABELS: Record<string, { en: string; fr: string }> = {
      n: { en: 'n', fr: 'n' },
      ...AGG_LABELS,
    }
    return subtitleStats
      .filter(s => s !== aggregate)
      .map(s => {
        const val = allStats[s]
        if (val == null) return null
        const label = STAT_LABELS[s]?.[lang] ?? s
        const formatted = s === 'n' ? val.toLocaleString() : formatNumber(val, decimals)
        return `${label} = ${formatted}`
      })
      .filter(Boolean) as string[]
  }, [isProportion, proportionResult, numericResult, subtitleStats, aggregate, lang, decimals])

  // Title
  const aggLabel = AGG_LABELS[aggregate]?.[lang] ?? aggregate
  const title = customTitle?.trim() || (column
    ? isProportion && proportionResult
      ? `${proportionResult.resolvedTarget} — ${column.name}`
      : `${aggLabel} — ${column.name}`
    : aggLabel)

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

  const hasChart = chartType !== 'none' && (values.length > 0 || (isProportion && sourceRows.length > 0))
  const isSideChart = hasChart && chartPosition === 'side'

  const kpiContent = (
    <div className={isSideChart ? 'flex-1 min-w-0' : undefined}>
      {/* Icon + title */}
      <div className={cn('flex items-center gap-2 mb-1', centerTitle && 'justify-center')}>
        <Icon size={compact ? 16 : 18} className={color.text} style={color.isCustom ? { color: color.hex } : undefined} />
        <span className="text-xs font-medium text-muted-foreground truncate">{title}</span>
      </div>

      {/* Big number + unit */}
      <div className={cn('flex items-baseline gap-1.5 mt-2', centerTitle && 'justify-center')}>
        <span className={cn('font-bold tracking-tight', color.text, compact ? 'text-3xl' : 'text-4xl')} style={color.isCustom ? { color: color.hex } : undefined}>
          {formatNumber(result, decimals)}
        </span>
        {unit && (
          <span className={cn('font-medium text-muted-foreground', compact ? 'text-base' : 'text-lg')}>
            {unit}
          </span>
        )}
      </div>

      {/* Subtitle stats */}
      {subtitleParts.length > 0 && (
        <div className={cn('mt-1.5 text-xs text-muted-foreground', centerTitle && 'text-center')}>
          {subtitleParts.join(' \u00b7 ')}
        </div>
      )}

      {/* Mini-chart below */}
      {hasChart && !isSideChart && (
        <div className="mt-3">
          <MiniChart
            values={values}
            chartType={chartType}
            bins={chartBins}
            showXAxis={showXAxis}
            hexColor={color.hex}
            colorMode={chartColors as 'mono' | 'multi'}
            column={column}
            rows={sourceRows}
          />
        </div>
      )}
    </div>
  )

  const content = isSideChart ? (
    <div className="flex items-center gap-4">
      {kpiContent}
      <div className="w-1/2 shrink-0">
        <MiniChart
          values={values}
          chartType={chartType}
          bins={chartBins}
          showXAxis={showXAxis}
          hexColor={color.hex}
          colorMode={chartColors as 'mono' | 'multi'}
          column={column}
          rows={sourceRows}
        />
      </div>
    </div>
  ) : kpiContent

  // Compact mode: fill entire widget, no inner card border
  if (compact) {
    return (
      <div className={cn('flex h-full flex-col justify-center p-4', color.bg)} style={color.isCustom ? { backgroundColor: `${color.hex}10` } : undefined}>
        {content}
      </div>
    )
  }

  // Standard mode (analysis panel): centered card with border
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className={cn('w-full max-w-sm rounded-xl border p-6', color.bg, color.accent)} style={color.isCustom ? { backgroundColor: `${color.hex}10`, borderColor: `${color.hex}30` } : undefined}>
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
  showXAxis?: boolean
  hexColor: string
  colorMode?: 'mono' | 'multi'
  column: { id: string; name: string; type: string }
  rows: Record<string, unknown>[]
}

const PIE_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab']

function MiniChart({ values, chartType, bins, showXAxis, hexColor, colorMode = 'mono', column, rows }: MiniChartProps) {
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
      <ResponsiveContainer width="100%" height={showXAxis ? 120 : 100}>
        <BarChart data={data} margin={{ top: 0, right: 4, left: 4, bottom: showXAxis ? 4 : 0 }}>
          {showXAxis && (
            <XAxis
              dataKey="label"
              tick={{ fontSize: 8 }}
              interval="preserveStartEnd"
              tickLine={false}
              axisLine={false}
            />
          )}
          <Bar dataKey="count" fill={hexColor} opacity={0.7} radius={[2, 2, 0, 0]} />
          <Tooltip {...TOOLTIP_STYLE} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'bar') {
    const useMulti = colorMode === 'multi'
    return (
      <ResponsiveContainer width="100%" height={Math.max(80, data.length * 22)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 9 }} />
          <Bar dataKey="value" fill={useMulti ? undefined : hexColor} opacity={0.7} radius={[0, 2, 2, 0]}>
            {useMulti && data.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Bar>
          <Tooltip {...TOOLTIP_STYLE} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'pie') {
    const useMono = colorMode === 'mono'
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
              <Cell key={i} fill={useMono ? hexColor : PIE_COLORS[i % PIE_COLORS.length]} opacity={useMono ? 0.5 + (i / data.length) * 0.5 : 1} />
            ))}
          </Pie>
          <Tooltip {...TOOLTIP_STYLE} />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  return null
}
