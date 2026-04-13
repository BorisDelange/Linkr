import { useMemo, useCallback } from 'react'
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

/** Compute a "nice" step size for histogram bins (1, 2, 5 × 10^n). */
function niceStep(rawStep: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const residual = rawStep / magnitude
  if (residual <= 1) return magnitude
  if (residual <= 2) return 2 * magnitude
  if (residual <= 5) return 5 * magnitude
  return 10 * magnitude
}

function buildHistogramData(values: number[], bins: number, startAtZero = false, decimals = 1) {
  if (values.length === 0) return []
  let min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ label: formatNumber(min, decimals), count: values.length }]

  if (startAtZero && min > 0) min = 0

  // Compute nice bin boundaries
  const rawStep = (max - min) / bins
  const step = niceStep(rawStep)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const nBins = Math.round((niceMax - niceMin) / step)

  const buckets = Array.from({ length: nBins }, (_, i) => ({
    label: formatNumber(niceMin + i * step, decimals),
    count: 0,
  }))
  for (const v of values) {
    let idx = Math.floor((v - niceMin) / step)
    if (idx >= nBins) idx = nBins - 1
    if (idx < 0) idx = 0
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
  const centerContent = (config.centerContent as boolean) ?? false
  const sizePct = (config.size as number | undefined) ?? 100
  const iconName = (config.icon as string) ?? 'Activity'
  const colorName = (config.color as string) ?? 'blue'
  const bgColorName = (config.bgColor as string) ?? 'none'
  const titleColorName = (config.titleColor as string) ?? 'auto'
  const chartType = (config.chartType as string) ?? 'none'
  const chartBins = (config.chartBins as number) ?? 15
  const showXAxis = (config.showXAxis as boolean) ?? false
  const xAxisLabel = (config.xAxisLabel as string | undefined) ?? ''
  const xAxisStartZero = (config.xAxisStartZero as boolean) ?? false
  const chartPosition = (config.chartPosition as string) ?? 'below'
  const chartColors = (config.chartColors as string) ?? 'mono'
  const decimals = (config.decimals as number | undefined) ?? 1
  const unit = (config.unit as string | undefined) ?? ''
  const subtitleStats = (config.subtitleStats as string[] | undefined) ?? ['n']

  const isProportion = aggregate === 'proportion'

  const column = columns.find(c => c.id === columnId)
  const color = resolveColor(colorName)
  const Icon = getLucideIcon(iconName)

  // Resolve detailed colors
  const bgColor = bgColorName === 'auto' ? color : bgColorName === 'none' ? null : resolveColor(bgColorName)
  const titleColor = titleColorName === 'auto' ? null : resolveColor(titleColorName)

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

  // Scale factor for all text/icon sizes (100% = default)
  const scale = sizePct / 100
  const iconSize = Math.round((compact ? 16 : 18) * scale)
  const numberSize = Math.round((compact ? 30 : 36) * scale)
  const unitSize = Math.round((compact ? 16 : 18) * scale)
  const titleSize = Math.round(12 * scale)
  const subtitleSize = Math.round(12 * scale)

  const kpiContent = (
    <div className={isSideChart ? 'flex-1 min-w-0' : undefined}>
      {/* Icon + title */}
      <div className={cn('flex items-center gap-2 mb-1', centerTitle && 'justify-center')}>
        <Icon size={iconSize} className={color.text} style={color.isCustom ? { color: color.hex } : undefined} />
        <span
          className={cn('font-medium truncate', titleColor ? titleColor.text : 'text-muted-foreground')}
          style={{ fontSize: titleSize, ...(titleColor?.isCustom ? { color: titleColor.hex } : {}) }}
        >
          {title}
        </span>
      </div>

      {/* Big number + unit */}
      <div className={cn('flex items-baseline gap-1.5 mt-2', centerContent && 'justify-center')}>
        <span className={cn('font-bold tracking-tight', color.text)} style={{ fontSize: numberSize, ...(color.isCustom ? { color: color.hex } : {}) }}>
          {formatNumber(result, decimals)}
        </span>
        {unit && (
          <span className="font-medium text-muted-foreground" style={{ fontSize: unitSize }}>
            {unit}
          </span>
        )}
      </div>

      {/* Subtitle stats */}
      {subtitleParts.length > 0 && (
        <div className={cn('mt-1.5 text-muted-foreground', centerContent && 'text-center')} style={{ fontSize: subtitleSize }}>
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
            xAxisLabel={xAxisLabel}
            xAxisStartZero={xAxisStartZero}
            decimals={decimals}
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
          xAxisLabel={xAxisLabel}
          hexColor={color.hex}
          colorMode={chartColors as 'mono' | 'multi'}
          column={column}
          rows={sourceRows}
        />
      </div>
    </div>
  ) : kpiContent

  // Resolve background styles
  const bgStyle: React.CSSProperties = {}
  let bgClasses = ''
  if (bgColor) {
    if (bgColor.isCustom) bgStyle.backgroundColor = `${bgColor.hex}10`
    else bgClasses = bgColor.bg
  }

  // Compact mode: fill entire widget, no inner card border
  if (compact) {
    return (
      <div className={cn('flex h-full flex-col justify-center p-4', bgClasses)} style={bgStyle}>
        {content}
      </div>
    )
  }

  // Standard mode (analysis panel): card with same border+shadow as dashboard widget
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className={cn('w-full max-w-sm rounded-lg border bg-card shadow-sm p-6', bgClasses)} style={bgStyle}>
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
  xAxisLabel?: string
  xAxisStartZero?: boolean
  decimals?: number
  hexColor: string
  colorMode?: 'mono' | 'multi'
  column: { id: string; name: string; type: string }
  rows: Record<string, unknown>[]
}

const PIE_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab']

function MiniChart({ values, chartType, bins, showXAxis, xAxisLabel, xAxisStartZero, decimals = 1, hexColor, colorMode = 'mono', column, rows }: MiniChartProps) {
  const data = useMemo(() => {
    if (chartType === 'histogram') {
      return buildHistogramData(values, bins, xAxisStartZero, decimals)
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
  }, [values, chartType, bins, xAxisStartZero, decimals, column.id, rows])

  // Total count for proportion calculation in tooltips
  const totalCount = useMemo(() => {
    if (chartType === 'histogram') return values.length
    return (data as { value?: number }[]).reduce((s, d) => s + (d.value ?? 0), 0)
  }, [data, values.length, chartType])

  // Custom tooltip content for clean display
  const renderTooltip = useCallback(({ active, payload }: { active?: boolean; payload?: { payload: Record<string, unknown> }[] }) => {
    if (!active || !payload?.[0]) return null
    const d = payload[0].payload
    const isHist = chartType === 'histogram'
    const val = isHist ? (d.label as string) : (d.name as string)
    const count = (isHist ? d.count : d.value) as number
    const pct = totalCount > 0 ? ((count / totalCount) * 100).toFixed(1) : '0'

    return (
      <div style={{ fontSize: 10, padding: '6px 10px', background: 'rgba(0,0,0,.85)', borderRadius: 4, color: '#fff', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{val}</div>
        <div>{isHist ? 'Count' : 'Count'}: {count.toLocaleString()}</div>
        <div>Proportion: {pct}%</div>
      </div>
    )
  }, [chartType, totalCount])

  if (data.length === 0) return null

  const hasXLabel = !!xAxisLabel
  const bottomMargin = (showXAxis ? 4 : 0) + (hasXLabel ? 16 : 0)

  if (chartType === 'histogram') {
    return (
      <ResponsiveContainer width="100%" height={(showXAxis ? 120 : 100) + (hasXLabel ? 16 : 0)}>
        <BarChart data={data} margin={{ top: 0, right: 4, left: 4, bottom: bottomMargin }}>
          {showXAxis && (
            <XAxis
              dataKey="label"
              tick={{ fontSize: 8 }}
              interval="preserveStartEnd"
              tickLine={false}
              axisLine={false}
              label={hasXLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -4, fontSize: 9, fill: '#888' } : undefined}
            />
          )}
          {!showXAxis && hasXLabel && (
            <XAxis
              dataKey="label"
              tick={false}
              tickLine={false}
              axisLine={false}
              label={{ value: xAxisLabel, position: 'insideBottom', offset: -4, fontSize: 9, fill: '#888' }}
            />
          )}
          <Bar dataKey="count" fill={hexColor} opacity={0.7} radius={[2, 2, 0, 0]} />
          <Tooltip content={renderTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'bar') {
    const useMulti = colorMode === 'multi'
    return (
      <ResponsiveContainer width="100%" height={Math.max(80, data.length * 22) + (hasXLabel ? 16 : 0)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: hasXLabel ? 16 : 0 }}>
          <XAxis
            type="number"
            hide={!hasXLabel}
            tick={false}
            tickLine={false}
            axisLine={false}
            label={hasXLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -4, fontSize: 9, fill: '#888' } : undefined}
          />
          <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 9 }} />
          <Bar dataKey="value" fill={useMulti ? undefined : hexColor} opacity={0.7} radius={[0, 2, 2, 0]}>
            {useMulti && data.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Bar>
          <Tooltip content={renderTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
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
          <Tooltip content={renderTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  return null
}
