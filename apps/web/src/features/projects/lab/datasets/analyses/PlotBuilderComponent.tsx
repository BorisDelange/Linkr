import { useMemo, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChartScatter } from 'lucide-react'
import { AnalysisLoading, usePluginName } from '@/components/ui/analysis-loading'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { resolveColor, getLucideIcon, aggregateByEntity, CHART_PALETTES, resolvePalette } from '@/lib/plugins/shared-styles'
import { outlierBounds, isWithinBounds, type OutlierMethod } from '@/lib/outliers'
import { type ZoomWindow } from './histogram-zoom'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import { useRenderRefresh } from '@/hooks/use-render-refresh'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import type { LocalizedString } from '@/types'
import { buildPlotBuilderSpec } from './plot-builder-server'
import { readCategoryOrder, readCustomCategoryOrder } from './plot-category-order'
import { MAX_PLOT_POINTS, sampleEvenly, sampleRandom } from './plot-sampling'
import { toNumeric, type PlotServerData } from './plot-builder-shared'
import { BoxViolinPlot } from './plot-builder-box-chart'
import { PiePlot } from './plot-builder-pie'
import { ScatterPlot, LinePlot } from './plot-builder-xy-charts'
import { BarPlot } from './plot-builder-bar-chart'
import { HistogramPlot } from './plot-builder-histogram-chart'

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
  const requestKey = server && datasetFileId && specKey ? `${specKey}|${filtersKey}` : null
  const { refreshing, settle, failure: serverError } = useRenderRefresh(requestKey)
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('plot-builder', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) { settle(requestKey, out.stderr); return }
        try { setServerData(JSON.parse(out.stdout.trim()) as PlotServerData); settle(requestKey) }
        catch { settle(requestKey, out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) settle(requestKey, String(e)) })
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
