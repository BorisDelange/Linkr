import { useMemo, useCallback, useRef, useState, useEffect } from 'react'
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
import type { ContentType } from 'recharts/types/component/Tooltip'
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent'
import { Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnalysisLoading, usePluginName } from '@/components/ui/analysis-loading'
import { resolveColor, getLucideIcon, resolvePalette, CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { TruncatedTick } from './chart-axis-helpers'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import { useRenderRefresh } from '@/hooks/use-render-refresh'
import { localized } from '@/lib/localized'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import type { LocalizedString } from '@/types'
import { buildKeyIndicatorSpec } from './key-indicator-server'
import { toComparableString } from '@/lib/dataset-utils'
import { BoxPlot } from '@/components/charts/box-plot'
import { computeAggregate, computeKpiValue, computeNumeric, computeProportion, kpiMetricRows, computeBoxStats, kpiTrendDelta, stddev, type BoxStats, type KpiValueOptions } from './key-indicator-values'

/** Lays out its children at the container's width, then scales them down uniformly so they
 *  always fit the available height — the whole KPI (text + mini-chart) shrinks homogeneously
 *  instead of overflowing into a scrollbar when the widget is made small. */
function FitToContainer({ children }: { children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [box, setBox] = useState<{ width: number; scale: number }>({ width: 0, scale: 1 })

  const setContainer = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    if (!el) return
    const measure = () => {
      const content = contentRef.current
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (!content || cw === 0 || ch === 0) return
      const naturalH = content.scrollHeight
      const scale = naturalH > 0 ? Math.min(1, ch / naturalH) : 1
      setBox({ width: cw, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    observerRef.current = ro
  }, [])

  return (
    <div ref={setContainer} className="flex h-full w-full items-center justify-center overflow-hidden">
      <div
        ref={contentRef}
        style={{ width: box.width || '100%', transform: `scale(${box.scale})`, transformOrigin: 'center' }}
      >
        {children}
      </div>
    </div>
  )
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

interface KpiChart {
  type: string
  data: { label?: string; count?: number; name?: string; value?: number }[]
  /** Box plots carry a summary instead of a series; `data` is empty for them. */
  stats?: BoxStats | null
}

interface KpiServerData {
  error?: string
  isProportion: boolean
  result: number | null
  n?: number
  matchCount?: number
  resolvedTarget?: string
  allStats?: Record<string, number | null>
  nonNull?: number
  targetMatches?: number
  target?: string
  chart?: KpiChart | null
}

export function KeyIndicatorComponent({ config, columns, rows, compact, datasetFileId, datasetFilters, getPreviousPeriod }: ComponentPluginProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const server = isServerMode()
  const pluginName = usePluginName('key-indicator')

  const columnId = config.column as string | undefined
  const uniquePerId = config.uniquePer as string | undefined
  const uniqueAggregation = (config.uniqueAggregation as string) ?? 'first'
  const aggregate = (config.aggregate as string) ?? 'mean'
  const targetValue = (config.targetValue as string | undefined) ?? ''
  const title = localized(config.title as LocalizedString | string | undefined, i18n.language).trim()
  const centerTitle = (config.centerTitle as boolean) ?? true
  const centerContent = (config.centerContent as boolean) ?? true
  const sizePct = (config.size as number | undefined) ?? 100
  const iconName = (config.icon as string) ?? 'Activity'
  const colorName = (config.color as string) ?? 'blue'
  const bgColorName = (config.bgColor as string) ?? 'none'
  const iconColorName = (config.iconColor as string) ?? 'auto'
  const valueColorName = (config.valueColor as string) ?? 'auto'
  const titleColorName = (config.titleColor as string) ?? 'auto'
  const unitColorName = (config.unitColor as string) ?? 'auto'
  const subtitleColorName = (config.subtitleColor as string) ?? 'auto'
  const chartType = (config.chartType as string) ?? 'none'
  const chartBins = (config.chartBins as number) ?? 15
  const showXAxis = (config.showXAxis as boolean) ?? false
  const xAxisLabel = (config.xAxisLabel as string | undefined) ?? ''
  const yLabelMaxLen = (config.yLabelMaxLen as number | undefined) ?? 11
  const xAxisStartZero = (config.xAxisStartZero as boolean) ?? false
  const chartPosition = (config.chartPosition as string) ?? 'below'
  const chartPaletteName = (config.chartPalette as string) ?? 'none'
  const chartCustomPalette = (config.chartCustomPalette as string) ?? ''
  const decimals = (config.decimals as number | undefined) ?? 1
  const unit = (config.unit as string | undefined) ?? ''
  const subtitleStats = (config.subtitleStats as string[] | undefined) ?? ['n']
  const excludeNA = (config.excludeNA as boolean) ?? true
  const showTrend = (config.showTrend as boolean) ?? false
  const trendDirection = (config.trendDirection as string) ?? 'up-is-bad'

  const isProportion = aggregate === 'proportion'
  const isNoneStat = aggregate === 'none'

  const column = columns.find(c => c.id === columnId)
  const color = resolveColor(colorName)
  const Icon = getLucideIcon(iconName)

  // Resolve detailed colors. "auto" means "follow the main color" for the icon and main
  // value (so they inherit Main unless explicitly overridden), and "inherit muted default"
  // for title/unit/subtitle.
  const bgColor = bgColorName === 'auto' ? color : bgColorName === 'none' ? null : resolveColor(bgColorName)
  const iconColor = iconColorName === 'auto' ? color : resolveColor(iconColorName)
  const valueColor = valueColorName === 'auto' ? color : resolveColor(valueColorName)
  const titleColor = titleColorName === 'auto' ? null : resolveColor(titleColorName)
  const unitColor = unitColorName === 'auto' ? null : resolveColor(unitColorName)
  const subtitleColor = subtitleColorName === 'auto' ? null : resolveColor(subtitleColorName)

  // Mini-chart palette: "none" = a single color (the main color); otherwise the chosen palette.
  const chartPalette = chartPaletteName === 'none' ? [color.hex] : resolvePalette(chartPaletteName, chartCustomPalette)

  // Server mode: the backend computes the aggregate + stats + already-binned chart
  // data on the Parquet (rows never leave the server). Stable string keys so the
  // effect only re-fetches when inputs semantically change — never every render.
  const spec = server && datasetFileId && column
    ? buildKeyIndicatorSpec(columns, config)
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverData, setServerData] = useState<KpiServerData | null>(null)
  const [serverFailure, setServerFailure] = useState<{ key: string | null; message: string } | null>(null)
  const requestKey = server && datasetFileId && specKey ? `${specKey}|${filtersKey}` : null
  const { refreshing, settle } = useRenderRefresh(requestKey)
  // Keyed to the request it answered, so a new render clears a stale failure.
  const serverError = serverFailure?.key === requestKey ? serverFailure.message : null
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('key-indicator', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        settle(requestKey)
        if (out.stderr) { setServerFailure({ key: requestKey, message: out.stderr }); return }
        try { setServerData(JSON.parse(out.stdout.trim()) as KpiServerData); setServerFailure(null) }
        catch { setServerFailure({ key: requestKey, message: out.stdout || 'Failed to parse result' }) }
      })
      .catch((e) => { if (!cancelled) { settle(requestKey); setServerFailure({ key: requestKey, message: String(e) }) } })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const valueOptions = useMemo<KpiValueOptions | null>(() => column
    ? { columnId: column.id, uniquePerId, uniqueAggregation, aggregate, targetValue, excludeNA }
    : null, [column, uniquePerId, uniqueAggregation, aggregate, targetValue, excludeNA])

  // Previous equivalent period, for the trend. The server computes it with the
  // same spec on the shifted filters; front-only recomputes from the shifted rows.
  const previous = useMemo(
    () => (showTrend && getPreviousPeriod ? getPreviousPeriod() : null),
    [showTrend, getPreviousPeriod],
  )
  const previousFiltersKey = JSON.stringify(previous?.datasetFilters ?? null)
  // Keyed by the request it answers, so a stale value never shows for new filters.
  const previousKey = `${specKey}|${previousFiltersKey}`
  const [previousServer, setPreviousServer] = useState<{ key: string; value: number | null } | null>(null)
  useEffect(() => {
    if (!server || !datasetFileId || !spec || !previous) return
    let cancelled = false
    renderOnServer('key-indicator', { ...spec, chartType: 'none' }, { datasetFileId, datasetFilters: previous.datasetFilters })
      .then((out) => {
        if (cancelled || out.stderr) return
        try {
          const data = JSON.parse(out.stdout.trim()) as KpiServerData
          setPreviousServer({ key: previousKey, value: data.error ? null : data.result })
        } catch { /* no comparison rather than a broken card */ }
      })
      .catch(() => { /* idem */ })
    return () => { cancelled = true }
  }, [server, datasetFileId, previousKey, !!previous]) // eslint-disable-line react-hooks/exhaustive-deps
  const previousValue = useMemo(() => {
    if (!previous || !valueOptions) return null
    if (server) return previousServer?.key === previousKey ? previousServer.value : null
    return computeKpiValue(previous.rows, valueOptions)
  }, [previous, valueOptions, server, previousServer, previousKey])

  // Rows that feed the indicator: one per entity when "Unique per" is set, then
  // optionally without NA/empty values of the chosen column.
  const metricRows = useMemo(
    () => (valueOptions ? kpiMetricRows(rows, valueOptions) : rows),
    [rows, valueOptions],
  )

  // For proportion mode: compute proportion of target value
  const proportionResult = useMemo(() => {
    if (!isProportion || !valueOptions) return null
    if (server) {
      if (!serverData || serverData.error || !serverData.isProportion) return null
      return {
        result: serverData.result ?? 0,
        n: serverData.n ?? 0,
        matchCount: serverData.matchCount ?? 0,
        resolvedTarget: serverData.resolvedTarget ?? '',
      }
    }
    return computeProportion(rows, metricRows, valueOptions)
  }, [isProportion, valueOptions, rows, metricRows, server, serverData])

  // For numeric mode: compute numeric aggregate + all stats
  const numericResult = useMemo(() => {
    if (isProportion || !valueOptions) return null
    if (server) {
      if (!serverData || serverData.error || serverData.isProportion) return null
      return {
        values: [] as number[],
        result: serverData.result,
        allStats: serverData.allStats ?? {},
        nonNull: serverData.nonNull ?? 0,
        targetMatches: serverData.targetMatches ?? 0,
        target: serverData.target ?? '',
      }
    }
    const { values: vals, result: res, nonNull, targetMatches, target } = computeNumeric(metricRows, valueOptions)
    const stats: Record<string, number | null> = {
      n: nonNull,
      mean: computeAggregate(vals, 'mean'),
      median: computeAggregate(vals, 'median'),
      sd: vals.length > 0 ? stddev(vals) : null,
      min: computeAggregate(vals, 'min'),
      max: computeAggregate(vals, 'max'),
      q1: computeAggregate(vals, 'q1'),
      q3: computeAggregate(vals, 'q3'),
      iqr: computeAggregate(vals, 'iqr'),
    }
    return { values: vals, result: res, allStats: stats, nonNull, targetMatches, target }
  }, [isProportion, valueOptions, metricRows, server, serverData])

  // Unified result
  const result = isProportion ? proportionResult?.result ?? null : numericResult?.result ?? null
  const values = numericResult?.values ?? []
  const trendDelta = showTrend ? kpiTrendDelta(result, previousValue, isProportion) : null

  // Build subtitle parts
  const subtitleParts = useMemo(() => {
    if (isProportion) {
      if (!proportionResult) return []
      const parts: string[] = []
      // A proportion reads as "matches / total": the denominator alone says little.
      if (subtitleStats.includes('n')) parts.push(`${proportionResult.matchCount.toLocaleString()} / ${proportionResult.n.toLocaleString()}`)
      if (subtitleStats.includes('count')) parts.push(`${proportionResult.resolvedTarget} = ${proportionResult.matchCount.toLocaleString()}`)
      return parts
    }
    const allStats = numericResult?.allStats
    if (!allStats) return []
    const STAT_LABELS: Record<string, { en: string; fr: string }> = {
      n: { en: 'n', fr: 'n' },
      ...AGG_LABELS,
    }
    // When a target value is chosen (count of a specific category), the subtitle stats describe
    // that target: "n" becomes the number of matching rows out of the total.
    const target = numericResult?.target
    return subtitleStats
      .filter(s => s !== aggregate)
      .map(s => {
        if (s === 'count') {
          if (!target) return null
          return `${target} = ${(numericResult?.targetMatches ?? 0).toLocaleString()} / ${(numericResult?.nonNull ?? 0).toLocaleString()}`
        }
        const val = allStats[s]
        if (val == null) return null
        const label = STAT_LABELS[s]?.[lang] ?? s
        const formatted = s === 'n' ? val.toLocaleString() : formatNumber(val, decimals)
        return `${label} = ${formatted}`
      })
      .filter(Boolean) as string[]
  }, [isProportion, proportionResult, numericResult, subtitleStats, aggregate, lang, decimals])

  if (!column) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.kpi_no_column')}
      </div>
    )
  }

  if (server && serverError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground whitespace-pre-wrap">
        {serverError}
      </div>
    )
  }

  if (spec && (!serverData || refreshing)) {
    return <AnalysisLoading icon={Gauge} name={pluginName} compact={compact} />
  }

  // In server mode, wait for the aggregate before deciding there is no data —
  // serverData null means the fetch is still in flight, not an empty result.
  if (result === null && !isNoneStat && !(server && !serverData)) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.no_data_available')}
      </div>
    )
  }

  // Chart data source: server mode uses the already-aggregated payload; front-only
  // derives it in MiniChart from values/rows. Histogram needs numeric values; bar/pie
  // build frequency counts from raw rows (works for categorical + "None" stat).
  const serverChart = server ? serverData?.chart ?? null : null
  // "Any row" reduces entities to match / no match, which only the progress line can
  // draw; the server sends no series for it either.
  const anyRow = isProportion && !!uniquePerId && uniqueAggregation === 'any'
  const hasChart = chartType !== 'none' && (
    // The progress line draws the proportion itself: no series to wait for.
    chartType === 'line'
      ? isProportion && result !== null
      : anyRow ? false : server
      // A box plot is described by `stats`, not by a series, so it has no `data`.
      ? !!serverChart && (chartType === 'boxplot' ? !!serverChart.stats : serverChart.data.length > 0)
      : chartType === 'histogram'
        ? values.length > 0
        // A box plot reads the column directly, so it works in proportion mode too,
        // where `values` is empty.
        : metricRows.length > 0
  )
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
        {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
        <Icon size={iconSize} className={iconColor.text} style={iconColor.isCustom ? { color: iconColor.hex } : undefined} />
        {title && (
          <span
            className={cn('font-medium truncate', titleColor ? titleColor.text : 'text-muted-foreground')}
            style={{ fontSize: titleSize, ...(titleColor?.isCustom ? { color: titleColor.hex } : {}) }}
          >
            {title}
          </span>
        )}
      </div>

      {/* Big number + unit — hidden when the main stat is "None". */}
      {!isNoneStat && result !== null && (
        <div className={cn('flex items-baseline gap-1.5 mt-2', centerContent && 'justify-center')}>
          <span className={cn('font-bold tracking-tight', valueColor.text)} style={{ fontSize: numberSize, ...(valueColor.isCustom ? { color: valueColor.hex } : {}) }}>
            {formatNumber(result, decimals)}
          </span>
          {unit && (
            <span
              className={cn('font-medium', unitColor ? unitColor.text : 'text-muted-foreground')}
              style={{ fontSize: unitSize, ...(unitColor?.isCustom ? { color: unitColor.hex } : {}) }}
            >
              {unit}
            </span>
          )}
        </div>
      )}

      {/* Subtitle stats + trend */}
      {(subtitleParts.length > 0 || trendDelta !== null) && (
        <div
          className={cn('mt-1.5 flex flex-wrap items-baseline gap-x-2 tabular-nums', subtitleColor ? subtitleColor.text : 'text-muted-foreground', centerContent && 'justify-center')}
          style={{ fontSize: subtitleSize, ...(subtitleColor?.isCustom ? { color: subtitleColor.hex } : {}) }}
        >
          {subtitleParts.length > 0 && <span>{subtitleParts.join(' \u00b7 ')}</span>}
          {trendDelta !== null && previous && previousValue !== null && (
            <TrendBadge
              delta={trendDelta}
              isProportion={isProportion}
              direction={trendDirection}
              title={t('datasets.kpi_trend_tooltip', {
                value: `${formatNumber(previousValue, decimals)}${isProportion ? ' %' : unit ? ` ${unit}` : ''}`,
                from: previous.from,
                to: previous.to,
              })}
            />
          )}
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
            yLabelMaxLen={yLabelMaxLen}
            xAxisStartZero={xAxisStartZero}
            decimals={decimals}
            palette={chartPalette}
            column={column}
            rows={metricRows}
            serverChart={serverChart}
            percent={isProportion ? result : null}
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
          yLabelMaxLen={yLabelMaxLen}
          xAxisStartZero={xAxisStartZero}
          decimals={decimals}
          palette={chartPalette}
          column={column}
          rows={metricRows}
          serverChart={serverChart}
          percent={isProportion ? result : null}
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

  // Compact mode: fill entire widget, no inner card border. Content auto-scales to fit so a
  // small widget shrinks everything proportionally rather than introducing a scrollbar.
  if (compact) {
    return (
      <div className={cn('h-full w-full p-4', bgClasses)} style={bgStyle}>
        <FitToContainer>{content}</FitToContainer>
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
  yLabelMaxLen?: number
  xAxisStartZero?: boolean
  decimals?: number
  palette?: string[]
  column: { id: string; name: string; type: string }
  rows: Record<string, unknown>[]
  /** Server mode: already-aggregated chart payload (histogram bins or freq counts). */
  serverChart?: KpiChart | null
  /** The proportion (0–100) the progress line fills to. */
  percent?: number | null
}

/** Arrow + change against the previous period, red when it moves the wrong way. */
function TrendBadge({ delta, isProportion, direction, title }: { delta: number; isProportion: boolean; direction: string; title: string }) {
  const { t } = useTranslation()
  const flat = Math.abs(delta) < 0.05
  const worse = direction === 'up-is-bad' ? delta > 0 : direction === 'up-is-good' ? delta < 0 : false
  const tone = flat || direction === 'neutral' ? null : resolveColor(worse ? 'red' : 'emerald')
  const arrow = flat ? '=' : delta > 0 ? '▲' : '▼'
  const amount = Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 1 })
  return (
    <span className={cn('font-medium', tone?.text)} title={title}>
      {arrow} {flat ? '' : `${amount} ${isProportion ? t('datasets.kpi_trend_points') : '%'}`}
    </span>
  )
}

const DEFAULT_MINI_PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab']

function MiniChart({ values, chartType, bins, showXAxis, xAxisLabel, yLabelMaxLen = 11, xAxisStartZero, decimals = 1, palette = DEFAULT_MINI_PALETTE, column, rows, serverChart, percent }: MiniChartProps) {
  // A single-color palette ("None") tints every bar/slice with the main color; pie slices
  // then get a graduated opacity so they stay distinguishable.
  const singleColor = palette.length === 1
  const data = useMemo(() => {
    // Server mode: the backend already binned/counted; render it verbatim.
    if (serverChart) return serverChart.data as { label?: string; count?: number; name?: string; value?: number }[]
    if (chartType === 'histogram') {
      return buildHistogramData(values, bins, xAxisStartZero, decimals)
    }
    if (chartType === 'bar' || chartType === 'pie') {
      // Frequency counts of raw values (top 10)
      const counts = new Map<string, number>()
      for (const row of rows) {
        const raw = row[column.id]
        if (raw == null) continue
        const key = toComparableString(raw)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, value]) => ({ name, value }))
    }
    return []
  }, [serverChart, values, chartType, bins, xAxisStartZero, decimals, column.id, rows])

  // Box plot: the server sends a summary, front-only computes the same one here.
  // The numbers come from the column itself rather than from `values`, which is
  // empty in proportion mode — the server summarises the column either way, and the
  // two modes must not disagree.
  const boxStats = useMemo(() => {
    if (chartType !== 'boxplot') return null
    if (serverChart) return serverChart.stats ?? null
    if (values.length > 0) return computeBoxStats(values)
    const nums = rows
      .map((r) => Number(r[column.id]))
      .filter((v) => Number.isFinite(v))
    return computeBoxStats(nums)
  }, [chartType, serverChart, values, rows, column.id])

  // Total count for proportion calculation in tooltips. Histogram front-only uses the
  // raw value count; server mode (values empty) sums the bin counts instead.
  const totalCount = useMemo(() => {
    if (chartType === 'histogram' && !serverChart) return values.length
    if (chartType === 'histogram') return (data as { count?: number }[]).reduce((s, d) => s + (d.count ?? 0), 0)
    return (data as { value?: number }[]).reduce((s, d) => s + (d.value ?? 0), 0)
  }, [data, values.length, chartType, serverChart])

  // Custom tooltip content for clean display
  // recharts' ContentType is broader than our narrowed payload shape; the
  // runtime fields we read (payload[0].payload) are a subset recharts provides.
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
        <div>Count: {count.toLocaleString()}</div>
        <div>Proportion: {pct}%</div>
      </div>
    )
  }, [chartType, totalCount]) as unknown as ContentType<ValueType, NameType>

  if (chartType === 'line') {
    if (percent == null) return null
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: palette[0] }} />
      </div>
    )
  }

  // Checked before the `data` guard: a box plot is described by its summary and
  // carries no series.
  if (chartType === 'boxplot') {
    if (!boxStats) return null
    return (
      <div className="px-1 pt-2">
        <BoxPlot
          min={boxStats.min}
          p25={boxStats.q1}
          median={boxStats.median}
          p75={boxStats.q3}
          max={boxStats.max}
          mean={boxStats.mean}
          height={44}
          color={palette[0]}
        />
      </div>
    )
  }

  if (data.length === 0) return null

  const hasXLabel = !!xAxisLabel
  const bottomMargin = (showXAxis ? 4 : 0) + (hasXLabel ? 16 : 0)

  if (chartType === 'histogram') {
    return (
      <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height={(showXAxis ? 120 : 100) + (hasXLabel ? 16 : 0)}>
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
          <Bar dataKey="count" fill={palette[0]} opacity={0.7} radius={[2, 2, 0, 0]} />
          <Tooltip content={renderTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'bar') {
    return (
      <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height={Math.max(80, data.length * 26) + (hasXLabel ? 16 : 0)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: hasXLabel ? 16 : 0 }}>
          <XAxis
            type="number"
            hide={!hasXLabel}
            tick={false}
            tickLine={false}
            axisLine={false}
            label={hasXLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -4, fontSize: 9, fill: '#888' } : undefined}
          />
          {/* interval=0 stops recharts from dropping category ticks when the chart is short (e.g. 3 rows in 80px).
              Axis width scales with the chosen label length so longer labels aren't clipped. */}
          <YAxis type="category" dataKey="name" width={Math.round(28 + yLabelMaxLen * 5)} interval={0} tick={<TruncatedTick maxLen={yLabelMaxLen} textAnchor="end" dx={-4} dy={3} fontSize={9} />} />
          <Bar dataKey="value" opacity={0.7} radius={[0, 2, 2, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={palette[i % palette.length]} />
            ))}
          </Bar>
          <Tooltip content={renderTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'pie') {
    return (
      <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height={120}>
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
              <Cell key={i} fill={singleColor ? palette[0] : palette[i % palette.length]} opacity={singleColor ? 0.5 + (i / data.length) * 0.5 : 1} />
            ))}
          </Pie>
          <Tooltip content={renderTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  return null
}
