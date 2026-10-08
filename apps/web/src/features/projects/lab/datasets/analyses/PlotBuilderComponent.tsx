import { useMemo, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChartScatter } from 'lucide-react'
import { AnalysisLoading, usePluginName } from '@/components/ui/analysis-loading'
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
} from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { niceTicks } from '@/lib/chart-ticks'
import { resolveColor, getLucideIcon, TOOLTIP_STYLE, aggregateByEntity, CHART_PALETTES, resolvePalette, CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { outlierBounds, isWithinBounds, type OutlierMethod } from '@/lib/outliers'
import { windowFromDrag, binCountForWindow, isZoomed, type ZoomWindow } from './histogram-zoom'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { TruncatedTick, TruncatedNumericTick } from './chart-axis-helpers'
import { ChartTooltipCard } from './chart-tooltip'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import { useRenderRefresh } from '@/hooks/use-render-refresh'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import type { LocalizedString } from '@/types'
import { buildPlotBuilderSpec } from './plot-builder-server'
import { orderCategories, readCategoryOrder, readCustomCategoryOrder, type CategoryOrder } from './plot-category-order'
import { MAX_PLOT_POINTS, sampleEvenly, sampleRandom } from './plot-sampling'
import { buildCategoricalData, formatNumericTick, NO_CUSTOM_ORDER, sharePct, toNumeric, type PlotScatterSeries, type PlotServerData } from './plot-builder-shared'
import { BoxViolinPlot } from './plot-builder-box-chart'
import { PiePlot } from './plot-builder-pie'
import { RankedBarList } from './ranked-bar-list'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDateRange(values: number[]): boolean {
  if (values.length === 0) return false
  const mid = values[Math.floor(values.length / 2)]
  return mid > 1e11 && mid < 1e14
}

function formatBinLabel(val: number, dateMode: boolean, decimals = 1): string {
  if (dateMode) {
    const d = new Date(val)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }
  return val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Count-axis tick: always whole numbers, never scientific notation. */
function formatCountTick(val: number | string): string {
  const n = typeof val === 'string' ? Number(val) : val
  if (isNaN(n)) return String(val)
  return Math.round(n).toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
}

function formatDateTick(val: number | string): string {
  const n = typeof val === 'string' ? Number(val) : val
  if (isNaN(n)) return String(val)
  const d = new Date(n)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
}

/** Compute bin parameters: aligned start, width, and count.
 *  When binWidth is provided, bins start at a round multiple of binWidth. */
function computeBinParams(min: number, max: number, binMode: string, binsConfig: number, binWidthConfig: number, startAtZero = false) {
  const effectiveMin = (startAtZero && min > 0) ? 0 : min
  if (binMode === 'width' && binWidthConfig > 0) {
    const bw = binWidthConfig
    const alignedMin = Math.floor(effectiveMin / bw) * bw
    const alignedMax = Math.ceil(max / bw) * bw
    const n = Math.max(1, Math.round((alignedMax - alignedMin) / bw))
    return { start: alignedMin, binWidth: bw, count: n }
  }
  const range = max - effectiveMin
  return { start: effectiveMin, binWidth: range / binsConfig, count: binsConfig }
}

function buildHistogramData(values: number[], binMode: string, binsConfig: number, binWidthConfig: number, startAtZero = false, decimals = 1) {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ bin: formatBinLabel(min, isDateRange(values), decimals), count: values.length, lo: min, hi: min }]
  const dateMode = isDateRange(values)
  const { start, binWidth, count } = computeBinParams(min, max, binMode, binsConfig, binWidthConfig, startAtZero)
  // `lo`/`hi` carry each bar's numeric edges alongside its formatted label: the
  // label is rounded for display and can't be parsed back, but drag-to-zoom needs
  // the real bounds to re-bin the values it selected.
  const buckets: { bin: string; count: number; lo: number; hi: number }[] = []
  for (let i = 0; i < count; i++) {
    const lo = start + i * binWidth
    buckets.push({ bin: formatBinLabel(lo, dateMode, decimals), count: 0, lo, hi: lo + binWidth })
  }
  for (const v of values) {
    let idx = Math.floor((v - start) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= count) idx = count - 1
    buckets[idx].count++
  }
  return buckets
}

/** True when fewer than half of the non-empty values parse as numbers — i.e. the column is categorical text. */
function isCategoricalColumn(rows: Record<string, unknown>[], col: string): boolean {
  let total = 0
  let numeric = 0
  for (const r of rows) {
    const v = r[col]
    if (v == null || v === '') continue
    total++
    if (!isNaN(toNumeric(v))) numeric++
    if (total >= 200) break
  }
  if (total === 0) return false
  return numeric / total < 0.5
}

/** Count occurrences of each category, split by group; ordered on the total over the groups. */
function buildCategoricalGrouped(rows: Record<string, unknown>[], col: string, groupCol: string, groupNames: string[], order: CategoryOrder, custom: readonly string[]) {
  const counts = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const v = r[col]
    if (v == null || v === '') continue
    const key = String(v)
    const g = String(r[groupCol] ?? '')
    if (!groupNames.includes(g)) continue
    let entry = counts.get(key)
    if (!entry) {
      entry = Object.fromEntries(groupNames.map(n => [n, 0]))
      counts.set(key, entry)
    }
    entry[g]++
  }
  const total = (entry: Record<string, number>) => groupNames.reduce((s, n) => s + entry[n], 0)
  return orderCategories(Array.from(counts), ([bin]) => bin, ([, entry]) => total(entry), order, custom)
    .map(([bin, entry]) => ({ bin, ...entry }))
}

function buildHistogramGrouped(
  rows: Record<string, unknown>[],
  xCol: string,
  groupCol: string,
  binMode: string,
  binsConfig: number,
  binWidthConfig: number,
  groupNames: string[],
  startAtZero = false,
  decimals = 1,
) {
  const allVals = rows.map(r => toNumeric(r[xCol])).filter(v => !isNaN(v))
  if (allVals.length === 0) return []
  const min = Math.min(...allVals)
  const max = Math.max(...allVals)
  const dateMode = isDateRange(allVals)
  if (min === max) return [{ bin: formatBinLabel(min, dateMode, decimals), ...Object.fromEntries(groupNames.map(g => [g, 0])) }]
  const { start, binWidth, count } = computeBinParams(min, max, binMode, binsConfig, binWidthConfig, startAtZero)

  const buckets: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const lo = start + i * binWidth
    const entry: Record<string, unknown> = { bin: formatBinLabel(lo, dateMode, decimals), lo, hi: lo + binWidth }
    for (const g of groupNames) entry[g] = 0
    buckets.push(entry)
  }

  for (const row of rows) {
    const v = toNumeric(row[xCol])
    if (isNaN(v)) continue
    let idx = Math.floor((v - start) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= count) idx = count - 1
    const g = String(row[groupCol] ?? '')
    if (g in (buckets[idx] as Record<string, unknown>)) {
      ;(buckets[idx] as Record<string, number>)[g]++
    }
  }
  return buckets
}

// ---------------------------------------------------------------------------
// Legend position helper
// ---------------------------------------------------------------------------

function buildLegendProps(position: string, fontSize = 11): Record<string, unknown> {
  // Bounded, scrollable wrapper so a long legend (e.g. many group×fill combos) stays small and
  // never crushes the plot: side legends cap their width, stacked ones cap their height.
  const vertical = { fontSize, lineHeight: 1.3, maxWidth: '42%', maxHeight: '100%', overflowY: 'auto' as const, overflowX: 'hidden' as const }
  const horizontal = { fontSize, lineHeight: 1.3, maxHeight: '32%', overflowY: 'auto' as const }
  // Recharts paints legend text in the series colour; a light series then
  // vanishes on a light card. The swatch carries the colour, the text stays legible.
  const formatter = (value: unknown) => <span style={{ color: 'var(--color-foreground)' }}>{String(value)}</span>
  switch (position) {
    case 'top-right':
      return { verticalAlign: 'top', align: 'right', layout: 'vertical', wrapperStyle: vertical, formatter }
    case 'top-left':
      return { verticalAlign: 'top', align: 'left', layout: 'vertical', wrapperStyle: vertical, formatter }
    case 'top-center':
      return { verticalAlign: 'top', align: 'center', wrapperStyle: horizontal, formatter }
    default: // 'bottom'
      return { verticalAlign: 'bottom', align: 'center', wrapperStyle: horizontal, formatter }
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PlotBuilderComponent({ config, columns, rows, compact, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t, i18n } = useTranslation()
  const server = isServerMode()
  const pluginName = usePluginName('plot-builder')

  // Config
  const cardIcon = (config.cardIcon as string) ?? '__none__'
  const cardColor = (config.cardColor as string) ?? 'none'
  const bgColorName = (config.bgColor as string) ?? 'none'
  const titleColorName = (config.titleColor as string) ?? 'auto'
  const iconColorName = (config.iconColor as string) ?? 'auto'
  const centerTitle = (config.centerTitle as boolean) ?? true
  const plotType = (config.plotType as string) ?? 'scatter'
  const xCol = config.xColumn as string | undefined
  // A pie counts one variable: a Y left over from another plot type must not filter its rows.
  const yCol = plotType === 'pie' ? undefined : config.yColumn as string | undefined
  const uniquePerId = config.uniquePer as string | undefined
  const uniqueAggregation = (config.uniqueAggregation as string) ?? 'first'
  const groupCol = config.groupColumn as string | undefined
  const binMode = (config.binMode as string) ?? 'count'
  const binsConfig = (config.bins as number) ?? 20
  const binWidthConfig = (config.binWidth as number) ?? 5
  const barMode = (config.barMode as string) ?? 'grouped'
  const histogramOrientation = (config.histogramOrientation as string) ?? 'vertical'
  const boxplotOrientation = (config.boxplotOrientation as string) ?? 'vertical'
  const boxStyle = (config.boxStyle as string) ?? 'filled'
  const categoryOrder = readCategoryOrder(config)
  const rawCustomOrder = config.categoryOrderCustom
  const categoryOrderCustom = useMemo(() => readCustomCategoryOrder({ categoryOrderCustom: rawCustomOrder }), [rawCustomOrder])
  const showCount = (config.showCount as boolean) ?? false
  const barStyle = (config.barStyle as string) ?? 'classic'
  const excludeNA = (config.excludeNA as boolean) ?? true
  const outlierMethod = ((config.outlierMethod as string) ?? 'none') as OutlierMethod
  const outlierCoef = (config.outlierCoef as number) ?? 1.5
  const pointSize = (config.pointSize as number) ?? 4
  const opacityPct = (config.opacity as number) ?? 70
  const xLabelMaxLen = (config.xLabelMaxLen as number) ?? 20
  const yLabelMaxLen = (config.yLabelMaxLen as number) ?? 16
  const paletteName = (config.colorPalette as string) ?? 'default'
  const customPaletteStr = (config.customPalette as string) ?? ''
  const chartTitle = localized(config.title as LocalizedString | string | undefined, i18n.language).trim()
  const xLabel = (config.xLabel as string) ?? ''
  const yLabel = (config.yLabel as string) ?? ''
  const decimals = (config.decimals as number) ?? 1
  const xAxisStartZero = (config.xAxisStartZero as boolean) ?? false
  const yAxisStartZero = (config.yAxisStartZero as boolean) ?? false
  const showGrid = (config.showGrid as boolean) ?? true
  const showLegend = (config.showLegend as boolean) ?? true
  const legendPosition = (config.legendPosition as string) ?? 'bottom'
  const legendFontSize = (config.legendFontSize as number) ?? 11
  const barSize = (config.barSize as number) ?? 0

  const opacity = opacityPct / 100

  // Resolve colors
  const cardColorResolved = resolveColor(cardColor)
  const hasCardColor = cardColor !== 'none' && cardColor !== ''
  const bgColor = bgColorName !== 'none' && bgColorName !== '' ? resolveColor(bgColorName) : null
  const titleColor = titleColorName !== 'auto' ? resolveColor(titleColorName) : null
  // Icon color: "auto" follows the main color (muted-foreground when no main color is set).
  const iconColor = iconColorName !== 'auto' ? resolveColor(iconColorName) : null

  // Single color = the main color when set, else the first default-palette swatch.
  const singleColor = hasCardColor ? cardColorResolved.hex : CHART_PALETTES.default[0]

  // Palette = "none" means a single color for every series/box (the main color). Otherwise
  // use the chosen multi-color palette. (We no longer force the main color into slot 0 of a
  // palette, which produced e.g. one red box among monochrome ones.)
  const colors = useMemo(() => {
    if (paletteName === 'none') return [singleColor]
    return resolvePalette(paletteName, customPaletteStr)
  }, [paletteName, singleColor, customPaletteStr])

  // Aggregate rows per entity if uniquePer is set
  const aggregatedRows = useMemo(() => {
    if (!uniquePerId) return rows
    return aggregateByEntity(rows, uniquePerId, uniqueAggregation)
  }, [rows, uniquePerId, uniqueAggregation])

  // Filter out NA / missing values if excludeNA is enabled
  const naFilteredRows = useMemo(() => {
    if (!excludeNA) return aggregatedRows
    return aggregatedRows.filter(row => {
      if (xCol) {
        const xVal = row[xCol]
        if (xVal == null || xVal === '' || String(xVal).toLowerCase() === 'na') return false
      }
      if (yCol) {
        const yVal = row[yCol]
        if (yVal == null || yVal === '' || String(yVal).toLowerCase() === 'na') return false
      }
      return true
    })
  }, [aggregatedRows, excludeNA, xCol, yCol])

  // Drop outliers on the numeric axes. Bounds are computed per column over the
  // NA-filtered rows, then a row is kept only if every bounded axis is inside its
  // own fence — the excluded rows leave the computation entirely, so aggregates and
  // counts reflect the trimmed data. `excludedCount` feeds the notice under the chart.
  const { sourceRows, outliersExcluded } = useMemo(() => {
    if (outlierMethod === 'none') return { sourceRows: naFilteredRows, outliersExcluded: 0 }
    const axes = [xCol, yCol].filter((c): c is string => !!c)
    const boundsByCol = new Map<string, { lo: number; hi: number } | null>()
    for (const colId of axes) {
      const isNumeric = columns.find(c => c.id === colId)?.type === 'number'
      if (!isNumeric) continue
      const values = naFilteredRows
        .map(r => Number(r[colId]))
        .filter(v => Number.isFinite(v))
      boundsByCol.set(colId, outlierBounds(values, outlierMethod, outlierCoef))
    }
    if (boundsByCol.size === 0) return { sourceRows: naFilteredRows, outliersExcluded: 0 }
    const kept = naFilteredRows.filter(row => {
      for (const [colId, bounds] of boundsByCol) {
        const v = Number(row[colId])
        // A non-numeric cell has no fence to fail; NA handling stays excludeNA's job.
        if (Number.isFinite(v) && !isWithinBounds(v, bounds)) return false
      }
      return true
    })
    return { sourceRows: kept, outliersExcluded: naFilteredRows.length - kept.length }
  }, [naFilteredRows, outlierMethod, outlierCoef, xCol, yCol, columns])

  // Resolve group names
  const groupNames = useMemo(() => {
    if (!groupCol || !columns.find(c => c.id === groupCol)) return null
    const set = new Set<string>()
    for (const row of sourceRows) {
      const v = row[groupCol]
      if (v != null) set.add(String(v))
    }
    return Array.from(set).sort()
  }, [groupCol, columns, sourceRows])

  // Scatter/line draw one element per point: cap them (the server samples on its side).
  // A line is sorted first so the sample spans the X range, as the server does.
  const { plottedRows, pointsTotal } = useMemo(() => {
    const unsampled = { plottedRows: sourceRows, pointsTotal: 0 }
    if (server || (plotType !== 'scatter' && plotType !== 'line') || !xCol || !yCol) return unsampled
    const valid = sourceRows
      .map(row => ({ row, x: toNumeric(row[xCol]) }))
      .filter(p => !isNaN(p.x) && !isNaN(toNumeric(p.row[yCol])))
    if (valid.length <= MAX_PLOT_POINTS) return unsampled
    if (plotType === 'line') valid.sort((a, b) => a.x - b.x)
    const sample = plotType === 'line' ? sampleEvenly(valid) : sampleRandom(valid)
    return { plottedRows: sample.map(p => p.row), pointsTotal: valid.length }
  }, [server, plotType, sourceRows, xCol, yCol])

  // Server mode: the backend computes the chart data (aggregates for bar/histogram/box,
  // raw points for scatter/line) on the Parquet from a validated spec — it owns the
  // program, so a viewer can't run arbitrary code. Stable string keys so the effect
  // only re-fetches on a semantic change, never every render.
  // Histogram zoom lives here rather than in HistogramPlot because in server mode it
  // has to reach the spec: the backend re-bins the zoomed range on the real data.
  // A config or column change re-bins from scratch, and a window from the old binning
  // would be meaningless. Tag the zoom with the binning it was taken against and
  // ignore it once that changes, rather than clearing it from an effect (which would
  // cost an extra render pass on every config edit).
  const binningKey = `${xCol}|${yCol}|${binMode}|${binsConfig}|${binWidthConfig}|${datasetFileId}`
  const [rawZoom, setRawZoom] = useState<{ window: ZoomWindow; key: string } | null>(null)
  const zoom = rawZoom?.key === binningKey ? rawZoom.window : null
  const setZoom = useCallback(
    (w: ZoomWindow | null) => setRawZoom(w ? { window: w, key: binningKey } : null),
    [binningKey],
  )
  // Re-binning server-side is a request, and a zoom is a drag-release (not a
  // continuous stream), but debouncing still collapses a quick series of zooms.
  const debouncedZoom = useDebouncedValue(zoom, 300)

  const spec = server && datasetFileId && columns.length > 0
    ? buildPlotBuilderSpec(columns, config, debouncedZoom)
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverData, setServerData] = useState<PlotServerData | null>(null)
  const [serverFailure, setServerFailure] = useState<{ key: string | null; message: string } | null>(null)
  const requestKey = server && datasetFileId && specKey ? `${specKey}|${filtersKey}` : null
  const { refreshing, settle } = useRenderRefresh(requestKey)
  // Keyed to the request it answered, so a new render clears a stale failure.
  const serverError = serverFailure?.key === requestKey ? serverFailure.message : null
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('plot-builder', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        settle(requestKey)
        if (out.stderr) { setServerFailure({ key: requestKey, message: out.stderr }); return }
        try { setServerData(JSON.parse(out.stdout.trim()) as PlotServerData); setServerFailure(null) }
        catch { setServerFailure({ key: requestKey, message: out.stdout || 'Failed to parse result' }) }
      })
      .catch((e) => { if (!cancelled) { settle(requestKey); setServerFailure({ key: requestKey, message: String(e) }) } })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Validate
  const xColumn = columns.find(c => c.id === xCol)
  const yColumn = columns.find(c => c.id === yCol)

  // For a horizontal histogram the binned variable comes from Y (X is unused); vertical uses X.
  const isHorizontalHistogram = plotType === 'histogram' && histogramOrientation === 'horizontal'
  const histogramCol = isHorizontalHistogram ? yCol : xCol
  const histogramColumn = isHorizontalHistogram ? yColumn : xColumn

  // A horizontal box/violin has its columns swapped (categories on Y, values on X), like a
  // horizontal histogram. In axis-free terms: the required column sits on the category axis,
  // the optional one on the value axis.
  const isBoxLike = plotType === 'boxplot' || plotType === 'violin'
  const isHorizontalBox = isBoxLike && boxplotOrientation === 'horizontal'
  const boxCatCol = isHorizontalBox ? yCol : xCol
  const boxValCol = isHorizontalBox ? xCol : yCol
  const boxCatColumn = isHorizontalBox ? yColumn : xColumn
  const boxValColumn = isHorizontalBox ? xColumn : yColumn
  const requiredColumn = plotType === 'histogram' ? histogramColumn : isBoxLike ? boxCatColumn : xColumn
  const requiresY = isHorizontalHistogram || isHorizontalBox

  const resolvedXLabel = xLabel || ''
  const resolvedYLabel = yLabel || ''

  // Histogram requires its binned variable (Y when horizontal, X otherwise); other plots require X.
  if (!requiredColumn) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {requiresY
          ? t('datasets.plot_builder_select_y', 'Select a Y variable.')
          : t('datasets.plot_builder_select_x', 'Select an X variable to begin.')}
      </div>
    )
  }

  const needsY = plotType === 'scatter' || plotType === 'line'
  if (needsY && !yColumn) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.plot_builder_select_y', 'Select a Y variable.')}
      </div>
    )
  }

  // Scatter & line plot both axes on a numeric scale; a categorical column coerces to NaN
  // and silently drops every point. Surface that instead of rendering an empty chart.
  if (needsY) {
    const isPlottable = (c?: typeof xColumn) => !c || c.type === 'number' || c.type === 'date'
    const nonNumeric = !isPlottable(xColumn) ? xColumn : !isPlottable(yColumn) ? yColumn : null
    if (nonNumeric) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
          {t('datasets.plot_builder_axis_must_be_numeric', {
            defaultValue: '"{{column}}" is not numeric. Scatter and line plots need numeric (or date) X and Y axes.',
            column: nonNumeric.name,
          })}
        </div>
      )
    }
  }

  // Box/violin compute stats over a numeric value column (the value axis if given, else the
  // category axis). A categorical value column coerces to NaN for every row and renders
  // "No data" — say why instead.
  if (isBoxLike) {
    const valueColumn = boxValColumn ?? boxCatColumn
    if (valueColumn && valueColumn.type !== 'number') {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
          {isHorizontalBox
            ? t('datasets.plot_builder_value_must_be_numeric_horizontal', { column: valueColumn.name })
            : t('datasets.plot_builder_value_must_be_numeric', {
                defaultValue: '"{{column}}" is not numeric. Box and violin plots need a numeric value axis (Y), with an optional categorical X.',
                column: valueColumn.name,
              })}
        </div>
      )
    }
  }

  // Bar groups by a categorical X and averages a numeric Y. A categorical Y coerces to NaN
  // for every row, dropping all bars; X stays categorical so it doesn't need to be numeric.
  if (plotType === 'bar' && yColumn && yColumn.type !== 'number') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
        {t('datasets.plot_builder_bar_y_must_be_numeric', {
          defaultValue: '"{{column}}" is not numeric. Bar charts average a numeric Y over a categorical X (or leave Y empty to count rows).',
          column: yColumn.name,
        })}
      </div>
    )
  }

  const xIsDate = xColumn?.type === 'date'
  const yIsDate = yColumn?.type === 'date'

  if (server && serverError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground whitespace-pre-wrap">
        {serverError}
      </div>
    )
  }
  // Server mode: hold the frame until the aggregate arrives (empty rows would render "No data"),
  // and again when a slow refresh would leave the previous figures passing for current ones.
  if (server && (!serverData || refreshing)) {
    return <AnalysisLoading icon={ChartScatter} name={pluginName} compact={compact} />
  }
  const sd = server ? serverData : null

  // A chart that silently drops points misreads as the full distribution, so say how
  // many were excluded. Server mode reports its own count (it did the filtering).
  const excludedCount = server ? sd?.outliersExcluded ?? 0 : outliersExcluded
  const outlierNotice = excludedCount > 0 ? (
    <p className="shrink-0 px-1 pt-1 text-[10px] text-muted-foreground">
      {t('plugins.outliers_excluded', { count: excludedCount })}
    </p>
  ) : null
  const sampledFrom = server ? sd?.pointsTotal ?? 0 : pointsTotal
  const samplingNotice = sampledFrom > 0 ? (
    <p className="shrink-0 px-1 pt-1 text-[10px] text-muted-foreground">
      {t('plugins.points_sampled', {
        shown: MAX_PLOT_POINTS.toLocaleString(),
        total: sampledFrom.toLocaleString(),
      })}
    </p>
  ) : null

  // --- Build the chart body (without title) ---
  const chartBody = (
    <>
      {plotType === 'scatter' && (
        <ScatterPlot
          rows={plottedRows}
          xCol={xCol!}
          yCol={yCol!}
          groupCol={groupCol}
          groupNames={groupNames}
          colors={colors}
          pointSize={pointSize}
          opacity={opacity}
          xLabel={resolvedXLabel}
          yLabel={resolvedYLabel}
          showGrid={showGrid}
          showLegend={showLegend}
          legendPosition={legendPosition}
          legendFontSize={legendFontSize}
          xIsDate={xIsDate}
          yIsDate={yIsDate}
          xAxisStartZero={xAxisStartZero}
          yAxisStartZero={yAxisStartZero}
          decimals={decimals}
          serverData={sd}
        />
      )}
      {plotType === 'line' && (
        <LinePlot
          rows={plottedRows}
          xCol={xCol!}
          yCol={yCol!}
          groupCol={groupCol}
          groupNames={groupNames}
          colors={colors}
          pointSize={pointSize}
          opacity={opacity}
          xLabel={resolvedXLabel}
          yLabel={resolvedYLabel}
          showGrid={showGrid}
          showLegend={showLegend}
          legendPosition={legendPosition}
          legendFontSize={legendFontSize}
          xIsDate={xIsDate}
          xAxisStartZero={xAxisStartZero}
          yAxisStartZero={yAxisStartZero}
          decimals={decimals}
          serverData={sd}
        />
      )}
      {plotType === 'bar' && (
        <BarPlot
          rows={sourceRows}
          xCol={xCol!}
          yCol={yCol}
          groupCol={groupCol}
          groupNames={groupNames}
          colors={colors}
          opacity={opacity}
          xLabel={resolvedXLabel}
          yLabel={resolvedYLabel}
          showGrid={showGrid}
          showLegend={showLegend}
          legendPosition={legendPosition}
          legendFontSize={legendFontSize}
          decimals={decimals}
          xLabelMaxLen={xLabelMaxLen}
          barSize={barSize}
          categoryOrder={categoryOrder}
          categoryOrderCustom={categoryOrderCustom}
          serverData={sd}
        />
      )}
      {plotType === 'histogram' && (
        <HistogramPlot
          rows={sourceRows}
          xCol={histogramCol!}
          groupCol={groupCol}
          groupNames={groupNames}
          colors={colors}
          binMode={binMode}
          binsConfig={binsConfig}
          binWidthConfig={binWidthConfig}
          opacity={opacity}
          xLabel={resolvedXLabel}
          yLabel={resolvedYLabel}
          showGrid={showGrid}
          showLegend={showLegend}
          legendPosition={legendPosition}
          legendFontSize={legendFontSize}
          barMode={barMode}
          orientation={histogramOrientation}
          xAxisStartZero={xAxisStartZero}
          decimals={decimals}
          xLabelMaxLen={xLabelMaxLen}
          yLabelMaxLen={yLabelMaxLen}
          barSize={barSize}
          barStyle={barStyle}
          categoryOrder={categoryOrder}
          categoryOrderCustom={categoryOrderCustom}
          serverData={sd}
          zoom={zoom}
          onZoomChange={setZoom}
        />
      )}
      {plotType === 'pie' && (
        <PiePlot
          rows={sourceRows}
          xCol={xCol!}
          colors={colors}
          opacity={opacity}
          labelMaxLen={xLabelMaxLen}
          categoryOrder={categoryOrder}
          categoryOrderCustom={categoryOrderCustom}
          serverData={sd}
        />
      )}
      {plotType === 'boxplot' && (
        <BoxViolinPlot
          rows={sourceRows}
          catCol={boxCatCol!}
          valCol={boxValCol}
          colors={colors}
          opacity={opacity}
          valueLabel={isHorizontalBox ? resolvedXLabel : resolvedYLabel}
          showGrid={showGrid}
          violin={false}
          startAtZero={xAxisStartZero}
          xLabelMaxLen={xLabelMaxLen}
          decimals={decimals}
          horizontal={isHorizontalBox}
          boxStyle={boxStyle}
          categoryOrder={categoryOrder}
          categoryOrderCustom={categoryOrderCustom}
          showCount={showCount}
          serverData={sd}
        />
      )}
      {plotType === 'violin' && (
        <BoxViolinPlot
          rows={sourceRows}
          catCol={boxCatCol!}
          valCol={boxValCol}
          colors={colors}
          opacity={opacity}
          valueLabel={isHorizontalBox ? resolvedXLabel : resolvedYLabel}
          showGrid={showGrid}
          violin={true}
          startAtZero={xAxisStartZero}
          xLabelMaxLen={xLabelMaxLen}
          decimals={decimals}
          horizontal={isHorizontalBox}
          boxStyle={boxStyle}
          categoryOrder={categoryOrder}
          categoryOrderCustom={categoryOrderCustom}
          showCount={showCount}
          serverData={sd}
        />
      )}
    </>
  )

  // --- Rendering ---
  const color = cardColorResolved
  const hasIcon = cardIcon !== '__none__' && cardIcon !== ''
  const Icon = hasIcon ? getLucideIcon(cardIcon) : null

  // Background styles (from bgColor, independent of main color)
  const bgStyle: React.CSSProperties = {}
  let bgClasses = ''
  if (bgColor) {
    if (bgColor.isCustom) bgStyle.backgroundColor = `${bgColor.hex}10`
    else bgClasses = bgColor.bg
  }

  const titleElement = chartTitle ? (
    <span className={cn(
      'font-medium truncate',
      compact ? 'text-xs' : 'text-sm',
      titleColor?.text,
    )} style={titleColor?.isCustom ? { color: titleColor.hex } : undefined}>
      {chartTitle}
    </span>
  ) : null

  const header = (Icon || titleElement) ? (
    <div className={cn(
      'flex items-center gap-2',
      compact ? 'px-4 pt-3 pb-1' : 'mb-2',
      centerTitle && 'justify-center',
    )}>
      {Icon && (
        // eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data
        <Icon
          size={compact ? 16 : 18}
          className={iconColor ? iconColor.text : hasCardColor ? color.text : 'text-muted-foreground'}
          style={(iconColor ?? (hasCardColor ? color : undefined))?.isCustom ? { color: (iconColor ?? color).hex } : undefined}
        />
      )}
      {titleElement}
    </div>
  ) : null

  if (compact) {
    return (
      <div
        className={cn('flex h-full flex-col', bgClasses)}
        style={bgStyle}
      >
        {header}
        <div className="flex-1 min-h-0 px-2 pb-2">
          {chartBody}
        </div>
        {outlierNotice}
        {samplingNotice}
      </div>
    )
  }

  return (
    <div
      className={cn('flex h-full flex-col p-4 gap-2', bgClasses)}
      style={bgStyle}
    >
      {header}
      <div className="flex-1 min-h-0">
        {chartBody}
      </div>
      {outlierNotice}
      {samplingNotice}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

function ScatterPlot({
  rows, xCol, yCol, groupCol, groupNames, colors, pointSize, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, legendFontSize, xIsDate, yIsDate, xAxisStartZero, yAxisStartZero, decimals = 1, serverData,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; pointSize: number; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; legendFontSize?: number; xIsDate?: boolean; yIsDate?: boolean; xAxisStartZero?: boolean; yAxisStartZero?: boolean; decimals?: number; serverData?: PlotServerData | null
}) {
  const legendProps = buildLegendProps(legendPosition, legendFontSize)
  const data = useMemo(() => {
    if (serverData) return (serverData.series as PlotScatterSeries[]) ?? []
    if (!groupNames || !groupCol) {
      return [{
        name: 'all',
        data: rows
          .map(r => ({ x: toNumeric(r[xCol]), y: toNumeric(r[yCol]) }))
          .filter(d => !isNaN(d.x) && !isNaN(d.y)),
      }]
    }
    return groupNames.map(g => ({
      name: g,
      data: rows
        .filter(r => String(r[groupCol]) === g)
        .map(r => ({ x: toNumeric(r[xCol]), y: toNumeric(r[yCol]) }))
        .filter(d => !isNaN(d.x) && !isNaN(d.y)),
    }))
  }, [serverData, rows, xCol, yCol, groupCol, groupNames])

  // Nice rounded domains/ticks for numeric (non-date) axes.
  const xScale = useMemo(() => xIsDate ? null : niceTicks(data.flatMap(s => s.data.map(d => d.x)), xAxisStartZero), [data, xIsDate, xAxisStartZero])
  const yScale = useMemo(() => yIsDate ? null : niceTicks(data.flatMap(s => s.data.map(d => d.y)), yAxisStartZero), [data, yIsDate, yAxisStartZero])

  // Custom content: the default one lists x and y but never says which group a
  // point belongs to.
  const renderTooltip = useCallback(({ active, payload }: TooltipContentProps<number, string>) => {
    const point = payload?.[0]?.payload as { x?: number; y?: number } | undefined
    if (!active || !point || point.x == null || point.y == null) return null
    const seriesIndex = data.findIndex(s => s.data.includes(point as { x: number; y: number }))
    const group = groupNames && seriesIndex >= 0 ? data[seriesIndex].name : undefined
    const fmtX = xIsDate ? formatDateTick : formatNumericTick(decimals)
    const fmtY = yIsDate ? formatDateTick : formatNumericTick(decimals)
    return (
      <ChartTooltipCard
        title={group}
        color={group ? colors[seriesIndex % colors.length] : undefined}
        rows={[
          { label: xLabel || xCol, value: fmtX(point.x) },
          { label: yLabel || yCol, value: fmtY(point.y) },
        ]}
      />
    )
  }, [data, groupNames, colors, xIsDate, yIsDate, decimals, xLabel, yLabel, xCol, yCol])

  return (
    <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height="100%">
      <ScatterChart margin={{ top: 12, right: 20, bottom: xLabel ? 22 : 4, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" name={xLabel || undefined} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedNumericTick formatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} />} height={28} tickFormatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} domain={xScale ? xScale.domain : (xAxisStartZero ? [0, 'auto'] : undefined)} ticks={xScale?.ticks} />
        <YAxis dataKey="y" type="number" name={yLabel || undefined} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11, style: { textAnchor: 'middle' } } : undefined} tick={{ fontSize: 10 }} width={56} tickFormatter={yIsDate ? formatDateTick : formatNumericTick(decimals)} domain={yScale ? yScale.domain : (yAxisStartZero ? [0, 'auto'] : undefined)} ticks={yScale?.ticks} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} content={renderTooltip} />
        {showLegend && groupNames && <Legend {...legendProps} />}
        {data.map((series, i) => (
          <Scatter
            key={series.name}
            name={series.name === 'all' ? undefined : series.name}
            data={series.data}
            fill={colors[i % colors.length]}
            fillOpacity={opacity}
            r={pointSize}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

function LinePlot({
  rows, xCol, yCol, groupCol, groupNames, colors, pointSize, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, legendFontSize, xIsDate, xAxisStartZero, yAxisStartZero, decimals = 1, serverData,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; pointSize: number; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; legendFontSize?: number; xIsDate?: boolean; xAxisStartZero?: boolean; yAxisStartZero?: boolean; decimals?: number; serverData?: PlotServerData | null
}) {
  const legendProps = buildLegendProps(legendPosition, legendFontSize)
  const { merged, series } = useMemo(() => {
    // Server sends per-series {x,y} points; merge into the wide {x, seriesA, seriesB} shape recharts needs.
    if (serverData) {
      const srv = (serverData.series as PlotScatterSeries[]) ?? []
      if (srv.length === 1 && srv[0].name === 'all') {
        return { merged: srv[0].data.map(d => ({ x: d.x, all: d.y })), series: ['all'] }
      }
      const map = new Map<number, Record<string, unknown>>()
      for (const s of srv) {
        for (const p of s.data) {
          if (!map.has(p.x)) map.set(p.x, { x: p.x })
          map.get(p.x)![s.name] = p.y
        }
      }
      const sorted = Array.from(map.values()).sort((a, b) => (a.x as number) - (b.x as number))
      return { merged: sorted, series: srv.map(s => s.name) }
    }
    if (!groupNames || !groupCol) {
      const sorted = rows
        .map(r => ({ x: toNumeric(r[xCol]), y: toNumeric(r[yCol]) }))
        .filter(d => !isNaN(d.x) && !isNaN(d.y))
        .sort((a, b) => a.x - b.x)
      return { merged: sorted.map(d => ({ x: d.x, all: d.y })), series: ['all'] }
    }

    const map = new Map<number, Record<string, unknown>>()
    for (const row of rows) {
      const xVal = toNumeric(row[xCol])
      const yVal = toNumeric(row[yCol])
      if (isNaN(xVal) || isNaN(yVal)) continue
      if (!map.has(xVal)) map.set(xVal, { x: xVal })
      const g = String(row[groupCol])
      map.get(xVal)![g] = yVal
    }
    const sorted = Array.from(map.values()).sort((a, b) => (a.x as number) - (b.x as number))
    return { merged: sorted, series: groupNames }
  }, [serverData, rows, xCol, yCol, groupCol, groupNames])

  const xScale = useMemo(() => xIsDate ? null : niceTicks(merged.map(d => d.x as number), xAxisStartZero), [merged, xIsDate, xAxisStartZero])
  const yScale = useMemo(() => {
    const ys: number[] = []
    for (const row of merged) for (const s of series) { const v = (row as Record<string, unknown>)[s]; if (typeof v === 'number') ys.push(v) }
    return niceTicks(ys, yAxisStartZero)
  }, [merged, series, yAxisStartZero])

  return (
    <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height="100%">
      <LineChart data={merged} margin={{ top: 12, right: 20, bottom: xLabel ? 22 : 4, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedNumericTick formatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} />} height={28} tickFormatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} domain={xScale ? xScale.domain : (xAxisStartZero ? [0, 'auto'] : undefined)} ticks={xScale?.ticks} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11, style: { textAnchor: 'middle' } } : undefined} tick={{ fontSize: 10 }} width={56} tickFormatter={formatNumericTick(decimals)} domain={yScale ? yScale.domain : undefined} ticks={yScale?.ticks} />
        <Tooltip
          {...TOOLTIP_STYLE}
          cursor={{ stroke: 'var(--color-muted-foreground)', strokeOpacity: 0.4, strokeDasharray: '3 3' }}
          labelFormatter={(label) => (xIsDate ? formatDateTick : formatNumericTick(decimals))(label as string | number)}
          formatter={(v, name) => [
            typeof v === 'number' ? formatNumericTick(decimals)(v) : String(v),
            name === 'all' ? (yLabel || yCol) : name,
          ]}
        />
        {showLegend && groupNames && <Legend {...legendProps} />}
        {series.map((s, i) => (
          <Line
            key={s}
            type="monotone"
            dataKey={s}
            name={s === 'all' ? undefined : s}
            stroke={colors[i % colors.length]}
            strokeOpacity={opacity}
            strokeWidth={Math.max(1, pointSize / 3)}
            dot={{ r: pointSize / 2, fillOpacity: opacity }}
            activeDot={{ r: pointSize }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------

function BarPlot({
  rows, xCol, yCol, groupCol, groupNames, colors, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, legendFontSize, decimals = 1, xLabelMaxLen = 20, barSize = 0, categoryOrder = null, categoryOrderCustom = NO_CUSTOM_ORDER, serverData,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol?: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; legendFontSize?: number; decimals?: number; xLabelMaxLen?: number; barSize?: number
  /** Null keeps each path's own order: counts by descending count, the others as met. */
  categoryOrder?: CategoryOrder | null; categoryOrderCustom?: readonly string[]; serverData?: PlotServerData | null
}) {
  const { t } = useTranslation()
  const legendProps = buildLegendProps(legendPosition, legendFontSize)
  const isCountMode = !yCol
  const dataKey = isCountMode ? 'count' : 'value'

  // Filling by the X variable itself yields one non-zero series per category, which recharts
  // draws in offset sub-slots. Treat it as a single series with one bar per category, coloured
  // individually — bars stay centred on their ticks.
  const colorByCategory = serverData ? !!serverData.colorByCategory : (!!groupCol && groupCol === xCol)
  const effGroupCol = colorByCategory ? undefined : groupCol
  const effGroupNames = colorByCategory ? null : groupNames

  const { data, series } = useMemo(() => {
    if (serverData) return { data: (serverData.data ?? []) as Record<string, unknown>[], series: (serverData.series as string[]) ?? [] }
    if (yCol) {
      if (!effGroupNames || !effGroupCol) {
        const map = new Map<string, { sum: number; count: number }>()
        for (const row of rows) {
          const key = String(row[xCol] ?? '')
          const val = toNumeric(row[yCol])
          if (isNaN(val)) continue
          const entry = map.get(key) ?? { sum: 0, count: 0 }
          entry.sum += val
          entry.count++
          map.set(key, entry)
        }
        const data = orderCategories(Array.from(map), ([name]) => name, ([, a]) => a.sum / a.count, categoryOrder ?? 'data', categoryOrderCustom)
          .slice(0, 30)
          .map(([name, { sum, count }]) => ({ name, value: sum / count }))
        return { data, series: ['value'] }
      }
      const map = new Map<string, Record<string, { sum: number; count: number }>>()
      for (const row of rows) {
        const key = String(row[xCol] ?? '')
        const g = String(row[effGroupCol] ?? '')
        const val = toNumeric(row[yCol])
        if (isNaN(val)) continue
        if (!map.has(key)) map.set(key, {})
        const inner = map.get(key)!
        if (!inner[g]) inner[g] = { sum: 0, count: 0 }
        inner[g].sum += val
        inner[g].count++
      }
      // Ordered on the category's mean over all its rows, whatever their group.
      const overallMean = (groups: Record<string, { sum: number; count: number }>) => {
        const all = Object.values(groups)
        return all.reduce((s, a) => s + a.sum, 0) / all.reduce((s, a) => s + a.count, 0)
      }
      const data = orderCategories(Array.from(map), ([name]) => name, ([, groups]) => overallMean(groups), categoryOrder ?? 'data', categoryOrderCustom)
        .slice(0, 30)
        .map(([name, groups]) => {
          const entry: Record<string, unknown> = { name }
          for (const g of effGroupNames) {
            const agg = groups[g]
            entry[g] = agg ? agg.sum / agg.count : 0
          }
          return entry
        })
      return { data, series: effGroupNames }
    }
    if (!effGroupNames || !effGroupCol) {
      const counts = new Map<string, number>()
      for (const row of rows) {
        const key = String(row[xCol] ?? '')
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const data = orderCategories(Array.from(counts), ([name]) => name, ([, count]) => count, categoryOrder ?? 'value-desc', categoryOrderCustom)
        .slice(0, 30)
        .map(([name, count]) => ({ name, count }))
      return { data, series: ['count'] }
    }
    const map = new Map<string, Record<string, number>>()
    for (const row of rows) {
      const key = String(row[xCol] ?? '')
      const g = String(row[effGroupCol] ?? '')
      if (!map.has(key)) map.set(key, {})
      const inner = map.get(key)!
      inner[g] = (inner[g] ?? 0) + 1
    }
    const total = (groups: Record<string, number>) => Object.values(groups).reduce((s, n) => s + n, 0)
    const data = orderCategories(Array.from(map), ([name]) => name, ([, groups]) => total(groups), categoryOrder ?? 'data', categoryOrderCustom)
      .slice(0, 30)
      .map(([name, groups]) => {
        const entry: Record<string, unknown> = { name }
        for (const g of effGroupNames) entry[g] = groups[g] ?? 0
        return entry
      })
    return { data, series: effGroupNames }
  }, [serverData, rows, xCol, yCol, effGroupCol, effGroupNames, categoryOrder, categoryOrderCustom])

  // Nice Y ticks starting at 0 — bar values are naturally anchored at the baseline.
  const yScale = useMemo(() => {
    const vals: number[] = [0]
    for (const row of data) for (const s of series) { const v = (row as Record<string, unknown>)[s]; if (typeof v === 'number') vals.push(v) }
    return niceTicks(vals, true)
  }, [data, series])

  // The more bars there are, the less horizontal room each label has, so tighten the truncation
  // as the category count grows (the full text stays available in the hover tooltip).
  const effXLabelMaxLen = Math.max(3, Math.min(xLabelMaxLen, Math.round(130 / Math.max(1, data.length))))

  return (
    <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 20, bottom: xLabel ? 22 : 4, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="name" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedTick maxLen={effXLabelMaxLen} angle={-30} textAnchor="end" />} interval={0} height={60} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11, style: { textAnchor: 'middle' } } : undefined} tick={{ fontSize: 10 }} width={56} tickFormatter={formatNumericTick(decimals)} domain={yScale ? yScale.domain : undefined} ticks={yScale?.ticks} />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: unknown, name) => [
            // Count mode yields integers; only the averaged-value mode needs decimals.
            typeof v !== 'number' ? String(v) : isCountMode ? v.toLocaleString() : formatNumericTick(decimals)(v),
            name === 'count' ? t('datasets.plot_builder_count') : name === 'value' ? (yLabel || yCol || name) : name,
          ]}
        />
        {showLegend && effGroupNames && <Legend {...legendProps} />}
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} name={s === dataKey ? undefined : s} fill={colors[i % colors.length]} fillOpacity={opacity} radius={[2, 2, 0, 0]} barSize={barSize || undefined} activeBar={{ fillOpacity: Math.min(1, opacity + 0.2), ...(colorByCategory ? {} : { stroke: colors[i % colors.length], strokeWidth: 1 }) }}>
            {colorByCategory && data.map((_, idx) => <Cell key={idx} fill={colors[idx % colors.length]} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Histogram (with grouped bar modes: grouped / stacked / overlay)
// ---------------------------------------------------------------------------

function HistogramPlot({
  rows, xCol, groupCol, groupNames, colors, binMode, binsConfig, binWidthConfig, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, legendFontSize, barMode, orientation, xAxisStartZero, decimals = 1, xLabelMaxLen = 12, yLabelMaxLen = 16, barSize = 0, barStyle = 'classic', categoryOrder = null, categoryOrderCustom = NO_CUSTOM_ORDER, serverData, zoom, onZoomChange,
}: {
  rows: Record<string, unknown>[]; xCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; binMode: string; binsConfig: number; binWidthConfig: number; opacity: number; xLabel: string; yLabel: string
  showGrid: boolean; showLegend: boolean; legendPosition: string; legendFontSize?: number; barMode: string; orientation: string; xAxisStartZero?: boolean; decimals?: number; xLabelMaxLen?: number; yLabelMaxLen?: number; barSize?: number; barStyle?: string
  categoryOrder?: CategoryOrder | null; categoryOrderCustom?: readonly string[]; serverData?: PlotServerData | null
  /** Drag-to-zoom window, owned by the parent so server mode can put it in the spec. */
  zoom?: ZoomWindow | null
  onZoomChange?: (zoom: ZoomWindow | null) => void
}) {
  const { t } = useTranslation()
  const isCategorical = useMemo(() => (serverData ? !!serverData.isCategorical : isCategoricalColumn(rows, xCol)), [serverData, rows, xCol])

  // Grouping by the histogram variable itself produces offset sub-slot bars; render a single
  // series instead, with one bar per category coloured individually (kept centred on its tick).
  const colorByCategory = serverData ? !!serverData.colorByCategory : (!!groupCol && groupCol === xCol)
  const effGroupCol = colorByCategory ? undefined : groupCol
  const effGroupNames = colorByCategory ? null : groupNames

  // Drag across the bars to zoom, double-click to reset. The window is a VALUE range,
  // and the values inside it are re-binned into the configured bin count — so zooming
  // reveals finer structure instead of drawing the same bars wider. Server mode sends
  // the range down and the backend re-bins on the real data (see the spec below).
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragTo, setDragTo] = useState<number | null>(null)

  const { data, series, effectiveBins } = useMemo(() => {
    if (serverData) {
      const d = (serverData.data ?? []) as Record<string, unknown>[]
      return { data: d, series: (serverData.series as string[]) ?? ['count'], effectiveBins: d.length }
    }
    if (isCategorical) {
      if (!effGroupNames || !effGroupCol) {
        const d = buildCategoricalData(rows, xCol, categoryOrder ?? 'value-desc', categoryOrderCustom)
        return { data: d, series: ['count'], effectiveBins: d.length }
      }
      const d = buildCategoricalGrouped(rows, xCol, effGroupCol, effGroupNames, categoryOrder ?? 'value-desc', categoryOrderCustom)
      return { data: d, series: effGroupNames, effectiveBins: d.length }
    }
    // Zoomed: keep only the rows inside the window, then bin those — capped at the
    // number of distinct values so an integer column doesn't come out as a comb.
    const zoomedRows = zoom
      ? rows.filter((r) => {
          const v = toNumeric(r[xCol])
          return !isNaN(v) && v >= zoom.lo && v <= zoom.hi
        })
      : rows
    const values = zoomedRows.map((r) => toNumeric(r[xCol])).filter((v) => !isNaN(v))
    const bins = zoom ? binCountForWindow(values, binsConfig) : binsConfig
    // `xAxisStartZero` pads the axis down to 0; inside a zoom that would drag the
    // view back out to the origin and undo the zoom.
    const startZero = zoom ? false : xAxisStartZero
    if (!effGroupNames || !effGroupCol) {
      const d = buildHistogramData(values, binMode, bins, binWidthConfig, startZero, decimals)
      return { data: d, series: ['count'], effectiveBins: d.length }
    }
    const d = buildHistogramGrouped(zoomedRows, xCol, effGroupCol, binMode, bins, binWidthConfig, effGroupNames, startZero, decimals)
    return { data: d, series: effGroupNames, effectiveBins: d.length }
  }, [serverData, isCategorical, rows, xCol, effGroupCol, effGroupNames, binMode, binsConfig, binWidthConfig, xAxisStartZero, decimals, zoom, categoryOrder, categoryOrderCustom])

  // Numeric edges of the drawn bars, for mapping a drag back onto values.
  const binBounds = useMemo(() => {
    const los = data.map((d) => (d as { lo?: number }).lo).filter((v): v is number => typeof v === 'number')
    const last = data[data.length - 1] as { hi?: number } | undefined
    return { los, upper: typeof last?.hi === 'number' ? last.hi : (los[los.length - 1] ?? 0) }
  }, [data])

  // Recharts types activeTooltipIndex as number | string | undefined (a category axis
  // can be keyed by label), so coerce to the bar position we actually need.
  const barIndex = (e: { activeTooltipIndex?: number | string | null }): number | null => {
    const i = e?.activeTooltipIndex
    if (i == null) return null
    const n = typeof i === 'number' ? i : Number(i)
    return Number.isInteger(n) ? n : null
  }

  const handleDragStart = useCallback((e: { activeTooltipIndex?: number | string | null }) => {
    setDragFrom(barIndex(e))
    setDragTo(null)
  }, [])

  const handleDragMove = useCallback((e: { activeTooltipIndex?: number | string | null }) => {
    setDragFrom((from) => {
      if (from != null) setDragTo(barIndex(e))
      return from
    })
  }, [])

  const handleDragEnd = useCallback(() => {
    const next = windowFromDrag(dragFrom, dragTo, binBounds.los, binBounds.upper)
    // The window is already in value space, so a zoom made while zoomed needs no
    // composition — it simply replaces the previous one.
    if (next) onZoomChange?.(next)
    setDragFrom(null)
    setDragTo(null)
  }, [dragFrom, dragTo, binBounds, onZoomChange])

  const handleDragCancel = useCallback(() => {
    setDragFrom(null)
    setDragTo(null)
  }, [])

  const zoomed = isZoomed(zoom)

  const hasGroups = effGroupNames != null && effGroupNames.length > 1
  const isOverlay = barMode === 'overlay' && hasGroups
  const isStacked = barMode === 'stacked' && hasGroups
  const effectiveOpacity = isOverlay ? Math.min(opacity, 0.5) : opacity
  const legendProps = buildLegendProps(legendPosition, legendFontSize)

  // Total count for proportion calculation
  const totalCount = useMemo(() => {
    let total = 0
    for (const d of data) {
      for (const s of series) {
        total += ((d as Record<string, unknown>)[s] as number) ?? 0
      }
    }
    return total
  }, [data, series])

  const isHorizontal = orientation === 'horizontal'
  // X axis label always labels the bottom (X-screen) axis; Y axis label the left (Y-screen) axis —
  // regardless of orientation. The count axis is X-screen when horizontal, Y-screen when vertical.
  const binAxisLabel = isHorizontal ? yLabel : xLabel
  const countAxisLabel = isHorizontal ? xLabel : yLabel
  // Tooltip needs a word for the effectif; only fall back to "Count" there, never on the empty axis title.
  const countLabel = countAxisLabel || t('datasets.plot_builder_count')
  const multiSeries = series.length > 1
  const renderHistTooltip = useCallback(({ active, payload, label }: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null
    return (
      <ChartTooltipCard
        title={label}
        color={multiSeries ? undefined : payload[0].color}
        rows={payload.map((p) => {
          const value = typeof p.value === 'number' ? p.value : 0
          return {
            label: multiSeries ? String(p.name) : countLabel,
            color: multiSeries ? p.color : undefined,
            value: value.toLocaleString(),
            note: `(${sharePct(value, totalCount)} %)`,
          }
        })}
      />
    )
  }, [totalCount, multiSeries, countLabel])

  const tickInterval = Math.max(0, Math.floor(effectiveBins / 10) - 1)
  const barRadius: [number, number, number, number] = isHorizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]

  // Axes: in horizontal mode the category/bin axis is Y (vertical) and the count axis is X (horizontal).
  const binAxisProps = {
    dataKey: 'bin',
    label: binAxisLabel ? { value: binAxisLabel, ...(isHorizontal ? { angle: -90, position: 'insideLeft' as const, offset: 5, style: { textAnchor: 'middle' as const } } : { position: 'insideBottom' as const, offset: -5 }), fontSize: 11 } : undefined,
    // On a horizontal chart the bin axis is vertical (Y): right-anchor labels left of the axis and vertically center them.
    tick: isHorizontal
      ? <TruncatedTick maxLen={yLabelMaxLen} textAnchor="end" dx={-4} dy={4} />
      : <TruncatedTick maxLen={xLabelMaxLen} angle={-30} textAnchor="end" />,
    interval: isHorizontal ? 0 : tickInterval,
  }
  // Horizontal Y category axis: size width to the longest displayed (truncated) label so the
  // plot shifts with the labels instead of keeping a fixed margin. ~6px/char + padding, plus the axis title.
  const yCatWidth = useMemo(() => {
    if (!isHorizontal) return 56
    let maxChars = 0
    for (const d of data) {
      const len = Math.min(String((d as { bin?: unknown }).bin ?? '').length, yLabelMaxLen)
      if (len > maxChars) maxChars = len
    }
    const titlePad = binAxisLabel ? 16 : 0
    return Math.round(Math.min(220, Math.max(40, maxChars * 6 + 16 + titlePad)))
  }, [isHorizontal, data, yLabelMaxLen, binAxisLabel])
  // Nice integer ticks for the count axis, starting at 0. Stacked bars sum per bin; otherwise use max single value.
  const countScale = useMemo(() => {
    let max = 0
    for (const d of data) {
      if (isStacked) {
        let sum = 0
        for (const s of series) sum += ((d as Record<string, unknown>)[s] as number) ?? 0
        if (sum > max) max = sum
      } else {
        for (const s of series) { const v = ((d as Record<string, unknown>)[s] as number) ?? 0; if (v > max) max = v }
      }
    }
    return niceTicks([0, max], true)
  }, [data, series, isStacked])

  const countAxisProps = {
    label: countAxisLabel ? { value: countAxisLabel, ...(isHorizontal ? { position: 'insideBottom' as const, offset: -5 } : { angle: -90, position: 'insideLeft' as const, offset: 5, style: { textAnchor: 'middle' as const } }), fontSize: 11 } : undefined,
    tick: { fontSize: 10 },
    tickFormatter: formatCountTick,
    allowDecimals: false,
    ...(countScale ? { domain: countScale.domain, ticks: countScale.ticks } : {}),
  }

  // The ranked list reads one count per category: numeric bins and a split by
  // another column keep the classic bars.
  if (barStyle === 'list' && isCategorical && !effGroupNames) {
    return (
      <RankedBarList
        data={data as { bin: string; count: number }[]}
        colors={colors}
        colorByCategory={colorByCategory}
        opacity={opacity}
        labelMaxLen={yLabelMaxLen}
        countLabel={countLabel}
      />
    )
  }

  return (
    <div className="relative h-full w-full">
      {zoomed && (
        <button
          onClick={() => onZoomChange?.(null)}
          className="absolute right-1 top-0 z-10 rounded border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
        >
          {t('plugins.reset_zoom')}
        </button>
      )}
      <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height="100%">
      <BarChart
        data={data}
        layout={isHorizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 12, right: 20, bottom: (isHorizontal ? countAxisLabel : binAxisLabel) ? 22 : 4, left: 10 }}
        onMouseDown={handleDragStart}
        onMouseMove={handleDragMove}
        onMouseUp={handleDragEnd}
        // Leaving mid-drag abandons it: committing there would zoom on a gesture
        // the user did not finish.
        onMouseLeave={handleDragCancel}
        onDoubleClick={() => onZoomChange?.(null)}
        style={{ userSelect: 'none' }}
        {...(isOverlay ? { barGap: '-100%' } : {})}
      >
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        {isHorizontal ? (
          <>
            <XAxis type="number" height={28} {...countAxisProps} />
            <YAxis type="category" width={yCatWidth} {...binAxisProps} />
          </>
        ) : (
          <>
            <XAxis {...binAxisProps} height={56} />
            <YAxis width={56} {...countAxisProps} />
          </>
        )}
        <Tooltip content={renderHistTooltip} cursor={TOOLTIP_STYLE.cursor} />
        {showLegend && effGroupNames && <Legend {...legendProps} />}
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            name={s === 'count' ? undefined : s}
            fill={colors[i % colors.length]}
            fillOpacity={effectiveOpacity}
            radius={barRadius}
            barSize={barSize || undefined}
            stackId={isStacked ? 'stack' : undefined}
            activeBar={{ fillOpacity: Math.min(1, effectiveOpacity + 0.2), ...(colorByCategory ? {} : { stroke: colors[i % colors.length], strokeWidth: 1 }) }}
          >
            {colorByCategory && data.map((_, idx) => <Cell key={idx} fill={colors[idx % colors.length]} />)}
          </Bar>
        ))}
        {/* Live selection while dragging. Bounds are bin labels, since the axis is categorical. */}
        {dragFrom != null && dragTo != null && dragFrom !== dragTo && (
          <ReferenceArea
            {...(isHorizontal
              ? { y1: binLabelAt(data, dragFrom), y2: binLabelAt(data, dragTo) }
              : { x1: binLabelAt(data, dragFrom), x2: binLabelAt(data, dragTo) })}
            strokeOpacity={0}
            fill="var(--color-primary)"
            fillOpacity={0.12}
          />
        )}
      </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** The bin label at an index, for a ReferenceArea bound on the categorical axis. */
function binLabelAt(data: Record<string, unknown>[], index: number): string | undefined {
  const row = data[index] as { bin?: unknown } | undefined
  return row?.bin == null ? undefined : String(row.bin)
}
