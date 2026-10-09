import { useMemo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceArea } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { niceTicks } from '@/lib/chart-ticks'
import { TOOLTIP_STYLE, CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { windowFromDrag, binCountForWindow, isZoomed, type ZoomWindow } from './histogram-zoom'
import { TruncatedTick } from './chart-axis-helpers'
import { ChartTooltipCard } from './chart-tooltip'
import { type CategoryOrder } from './plot-category-order'
import { buildCategoricalData, NO_CUSTOM_ORDER, sharePct, toNumeric, type PlotServerData } from './plot-builder-shared'
import { RankedBarList } from './ranked-bar-list'
import { formatCountTick, buildHistogramData, isCategoricalColumn, buildCategoricalGrouped, buildHistogramGrouped } from './plot-builder-data'
import { buildLegendProps } from './plot-builder-legend'

// ---------------------------------------------------------------------------
// Histogram (with grouped bar modes: grouped / stacked / overlay)
// ---------------------------------------------------------------------------

export function HistogramPlot({
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
