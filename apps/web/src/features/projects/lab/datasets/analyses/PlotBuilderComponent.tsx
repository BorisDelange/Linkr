import { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { cn } from '@/lib/utils'
import { resolveColor, getLucideIcon, TOOLTIP_STYLE, aggregateByEntity } from '@/lib/plugins/shared-styles'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const PALETTES: Record<string, string[]> = {
  default: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'],
  tableau10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
  pastel: ['#aec7e8', '#ffbb78', '#ff9896', '#98df8a', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5'],
  vivid: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999', '#66c2a5', '#fc8d62'],
  earth: ['#8c510a', '#bf812d', '#dfc27d', '#80cdc1', '#35978f', '#01665e', '#c7eae5', '#f6e8c3', '#d8b365', '#5ab4ac'],
  ocean: ['#08519c', '#3182bd', '#6baed6', '#9ecae1', '#c6dbef', '#084594', '#2171b5', '#4292c6', '#6baed6', '#9ecae1'],
  warm: ['#e41a1c', '#fc4e2a', '#fd8d3c', '#feb24c', '#fed976', '#d7301f', '#ef6548', '#fc8d59', '#fdbb84', '#fdd49e'],
  cool: ['#225ea8', '#1d91c0', '#41b6c4', '#7fcdbb', '#c7e9b4', '#253494', '#2c7fb8', '#41b6c4', '#a1dab4', '#ffffcc'],
  monochrome: ['#252525', '#525252', '#737373', '#969696', '#bdbdbd', '#d9d9d9', '#636363', '#a8a8a8', '#454545', '#cccccc'],
}

function parseCustomPalette(input: string): string[] | null {
  if (!input.trim()) return null
  const colors = input.split(',').map(s => s.trim()).filter(s => /^#[0-9a-fA-F]{3,8}$/.test(s))
  return colors.length > 0 ? colors : null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumeric(val: unknown): number {
  if (val == null) return NaN
  if (typeof val === 'number') return val
  const s = String(val).trim()
  const n = Number(s)
  if (!isNaN(n)) return n
  const ts = Date.parse(s)
  if (!isNaN(ts)) return ts
  return NaN
}

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

function formatNumericTick(decimals: number) {
  return (val: number | string): string => {
    const n = typeof val === 'string' ? Number(val) : val
    if (isNaN(n)) return String(val)
    if (Number.isInteger(n) && Math.abs(n) < 1e6) return n.toLocaleString()
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  }
}

function formatDateTick(val: number | string): string {
  const n = typeof val === 'string' ? Number(val) : val
  if (isNaN(n)) return String(val)
  const d = new Date(n)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
}

/** Truncate long text with ellipsis. Used for X-axis tick labels. */
function truncateLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

/** Custom tick component that truncates long labels and shows full text on hover via title. */
function TruncatedTick({ x, y, payload, maxLen = 16, angle = 0, textAnchor = 'middle', fontSize = 9 }: {
  x?: number; y?: number; payload?: { value: string }
  maxLen?: number; angle?: number; textAnchor?: string; fontSize?: number
}) {
  const full = String(payload?.value ?? '')
  const display = truncateLabel(full, maxLen)
  return (
    <g transform={`translate(${x},${y})`}>
      <title>{full}</title>
      <text
        x={0} y={0} dy={12}
        textAnchor={textAnchor}
        fontSize={fontSize}
        fill="currentColor"
        opacity={0.7}
        transform={angle ? `rotate(${angle})` : undefined}
      >
        {display}
      </text>
    </g>
  )
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
  if (min === max) return [{ bin: formatBinLabel(min, isDateRange(values), decimals), count: values.length }]
  const dateMode = isDateRange(values)
  const { start, binWidth, count } = computeBinParams(min, max, binMode, binsConfig, binWidthConfig, startAtZero)
  const buckets: { bin: string; count: number }[] = []
  for (let i = 0; i < count; i++) {
    const lo = start + i * binWidth
    buckets.push({ bin: formatBinLabel(lo, dateMode, decimals), count: 0 })
  }
  for (const v of values) {
    let idx = Math.floor((v - start) / binWidth)
    if (idx < 0) idx = 0
    if (idx >= count) idx = count - 1
    buckets[idx].count++
  }
  return buckets
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
    const entry: Record<string, unknown> = { bin: formatBinLabel(lo, dateMode, decimals) }
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

function computeBoxplotStats(values: number[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q1Idx = Math.floor(sorted.length * 0.25)
  const medIdx = Math.floor(sorted.length * 0.5)
  const q3Idx = Math.floor(sorted.length * 0.75)
  const q1 = sorted[q1Idx]
  const median = sorted[medIdx]
  const q3 = sorted[q3Idx]
  const iqr = q3 - q1
  const whiskerLow = Math.max(sorted[0], q1 - 1.5 * iqr)
  const whiskerHigh = Math.min(sorted[sorted.length - 1], q3 + 1.5 * iqr)
  return { min: whiskerLow, q1, median, q3, max: whiskerHigh, mean: values.reduce((s, v) => s + v, 0) / values.length }
}

// ---------------------------------------------------------------------------
// Boxplot / Violin sub-component (custom SVG)
// ---------------------------------------------------------------------------

interface BoxplotData {
  name: string
  stats: { min: number; q1: number; median: number; q3: number; max: number; mean: number }
  values: number[]
}

function BoxplotChart({
  data,
  colors,
  opacity,
  yLabel,
  showGrid,
  violin,
}: {
  data: BoxplotData[]
  colors: string[]
  opacity: number
  yLabel: string
  showGrid: boolean
  violin: boolean
}) {
  if (data.length === 0) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">No data</div>

  const allMin = Math.min(...data.map(d => d.stats.min))
  const allMax = Math.max(...data.map(d => d.stats.max))
  const range = allMax - allMin || 1
  const padding = range * 0.08

  const plotMin = allMin - padding
  const plotMax = allMax + padding
  const plotRange = plotMax - plotMin

  const marginLeft = 60
  const marginRight = 20
  const marginTop = 10
  const marginBottom = 40
  const width = 600
  const height = 340
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom

  const toY = (val: number) => marginTop + plotH - ((val - plotMin) / plotRange) * plotH

  const boxWidth = Math.min(60, Math.max(20, plotW / data.length - 10))

  const tickCount = 6
  const yTicks: number[] = []
  for (let i = 0; i <= tickCount; i++) {
    yTicks.push(plotMin + (plotRange * i) / tickCount)
  }

  function kernelDensity(values: number[], nPoints = 50): { val: number; density: number }[] {
    if (values.length < 2) return []
    const sorted = [...values].sort((a, b) => a - b)
    const bw = (sorted[sorted.length - 1] - sorted[0]) / 15 || 1
    const points: { val: number; density: number }[] = []
    for (let i = 0; i < nPoints; i++) {
      const val = plotMin + (plotRange * i) / (nPoints - 1)
      let sum = 0
      for (const v of values) {
        const u = (val - v) / bw
        sum += Math.exp(-0.5 * u * u)
      }
      points.push({ val, density: sum / (values.length * bw * Math.sqrt(2 * Math.PI)) })
    }
    return points
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {showGrid &&
        yTicks.map((tick, i) => (
          <line
            key={i}
            x1={marginLeft}
            x2={width - marginRight}
            y1={toY(tick)}
            y2={toY(tick)}
            stroke="currentColor"
            strokeOpacity={0.1}
            strokeDasharray="3,3"
          />
        ))}

      <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={marginTop + plotH} stroke="currentColor" strokeOpacity={0.2} />
      {yTicks.map((tick, i) => (
        <text key={i} x={marginLeft - 8} y={toY(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.6}>
          {tick.toPrecision(3)}
        </text>
      ))}

      {yLabel && (
        <text
          x={14}
          y={marginTop + plotH / 2}
          textAnchor="middle"
          fontSize={11}
          fill="currentColor"
          opacity={0.7}
          transform={`rotate(-90, 14, ${marginTop + plotH / 2})`}
        >
          {yLabel}
        </text>
      )}

      {data.map((d, i) => {
        const cx = marginLeft + (plotW / data.length) * (i + 0.5)
        const color = colors[i % colors.length]
        const { min, q1, median, q3, max } = d.stats

        if (violin) {
          const density = kernelDensity(d.values)
          if (density.length < 2) return null
          const maxD = Math.max(...density.map(p => p.density))
          const halfW = boxWidth * 0.6
          const pathPoints = density.map(p => ({
            y: toY(p.val),
            dx: maxD > 0 ? (p.density / maxD) * halfW : 0,
          }))
          const leftPath = pathPoints.map(p => `${cx - p.dx},${p.y}`).join(' ')
          const rightPath = [...pathPoints].reverse().map(p => `${cx + p.dx},${p.y}`).join(' ')
          return (
            <g key={i}>
              <polygon
                points={`${leftPath} ${rightPath}`}
                fill={color}
                fillOpacity={opacity}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.6}
              />
              <line x1={cx - halfW * 0.4} x2={cx + halfW * 0.4} y1={toY(median)} y2={toY(median)} stroke="white" strokeWidth={2} />
              <text x={cx} y={height - marginBottom + 20} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.7}>
                {d.name.length > 12 ? d.name.slice(0, 11) + '…' : d.name}
              </text>
            </g>
          )
        }

        const halfBox = boxWidth / 2
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={toY(max)} y2={toY(min)} stroke={color} strokeWidth={1.5} strokeOpacity={0.5} />
            <line x1={cx - halfBox * 0.4} x2={cx + halfBox * 0.4} y1={toY(max)} y2={toY(max)} stroke={color} strokeWidth={1.5} />
            <line x1={cx - halfBox * 0.4} x2={cx + halfBox * 0.4} y1={toY(min)} y2={toY(min)} stroke={color} strokeWidth={1.5} />
            <rect
              x={cx - halfBox}
              y={toY(q3)}
              width={boxWidth}
              height={toY(q1) - toY(q3)}
              fill={color}
              fillOpacity={opacity}
              stroke={color}
              strokeWidth={1.5}
              rx={2}
            />
            <line x1={cx - halfBox} x2={cx + halfBox} y1={toY(median)} y2={toY(median)} stroke="white" strokeWidth={2} />
            <text x={cx} y={height - marginBottom + 20} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.7}>
              {d.name.length > 12 ? d.name.slice(0, 11) + '…' : d.name}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Legend position helper
// ---------------------------------------------------------------------------

function buildLegendProps(position: string): Record<string, unknown> {
  switch (position) {
    case 'top-right':
      return { verticalAlign: 'top', align: 'right', layout: 'vertical' }
    case 'top-left':
      return { verticalAlign: 'top', align: 'left', layout: 'vertical' }
    case 'top-center':
      return { verticalAlign: 'top', align: 'center' }
    default: // 'bottom'
      return { verticalAlign: 'bottom', align: 'center' }
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PlotBuilderComponent({ config, columns, rows, compact }: ComponentPluginProps) {
  const { t } = useTranslation()

  // Config
  const cardIcon = (config.cardIcon as string) ?? '__none__'
  const cardColor = (config.cardColor as string) ?? 'none'
  const bgColorName = (config.bgColor as string) ?? 'none'
  const titleColorName = (config.titleColor as string) ?? 'auto'
  const centerTitle = (config.centerTitle as boolean) ?? false
  const plotType = (config.plotType as string) ?? 'scatter'
  const xCol = config.xColumn as string | undefined
  const yCol = config.yColumn as string | undefined
  const uniquePerId = config.uniquePer as string | undefined
  const uniqueAggregation = (config.uniqueAggregation as string) ?? 'first'
  const groupCol = config.groupColumn as string | undefined
  const binMode = (config.binMode as string) ?? 'count'
  const binsConfig = (config.bins as number) ?? 20
  const binWidthConfig = (config.binWidth as number) ?? 5
  const barMode = (config.barMode as string) ?? 'grouped'
  const excludeNA = (config.excludeNA as boolean) ?? true
  const pointSize = (config.pointSize as number) ?? 4
  const opacityPct = (config.opacity as number) ?? 70
  const paletteName = (config.colorPalette as string) ?? 'default'
  const customPaletteStr = (config.customPalette as string) ?? ''
  const chartTitle = (config.title as string) ?? ''
  const xLabel = (config.xLabel as string) ?? ''
  const yLabel = (config.yLabel as string) ?? ''
  const decimals = (config.decimals as number) ?? 1
  const xAxisStartZero = (config.xAxisStartZero as boolean) ?? false
  const showGrid = (config.showGrid as boolean) ?? true
  const showLegend = (config.showLegend as boolean) ?? true
  const legendPosition = (config.legendPosition as string) ?? 'bottom'

  const opacity = opacityPct / 100
  const paletteColors = paletteName === 'custom'
    ? (parseCustomPalette(customPaletteStr) ?? PALETTES.default)
    : (PALETTES[paletteName] ?? PALETTES.default)

  // Resolve colors
  const cardColorResolved = resolveColor(cardColor)
  const hasCardColor = cardColor !== 'none' && cardColor !== ''
  const bgColor = bgColorName !== 'none' && bgColorName !== '' ? resolveColor(bgColorName) : null
  const titleColor = titleColorName !== 'auto' ? resolveColor(titleColorName) : null
  const colors = useMemo(() => {
    if (hasCardColor && !groupCol) {
      return [cardColorResolved.hex, ...paletteColors.slice(1)]
    }
    return paletteColors
  }, [hasCardColor, groupCol, cardColorResolved.hex, paletteColors])

  // Aggregate rows per entity if uniquePer is set
  const aggregatedRows = useMemo(() => {
    if (!uniquePerId) return rows
    return aggregateByEntity(rows, uniquePerId, uniqueAggregation)
  }, [rows, uniquePerId, uniqueAggregation])

  // Filter out NA / missing values if excludeNA is enabled
  const sourceRows = useMemo(() => {
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

  // Validate
  const xColumn = columns.find(c => c.id === xCol)
  const yColumn = columns.find(c => c.id === yCol)

  const resolvedXLabel = xLabel || ''
  const resolvedYLabel = yLabel || ''
  const resolvedTitle =
    chartTitle ||
    (plotType === 'histogram'
      ? `${t('datasets.plot_builder_histogram', 'Histogram')}: ${xColumn?.name ?? xCol ?? ''}`
      : `${xColumn?.name ?? xCol ?? ''} vs ${yColumn?.name ?? yCol ?? ''}`)

  if (!xColumn) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.plot_builder_select_x', 'Select an X variable to begin.')}
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

  const xIsDate = xColumn?.type === 'date'
  const yIsDate = yColumn?.type === 'date'

  // --- Build the chart body (without title) ---
  const chartBody = (
    <>
      {plotType === 'scatter' && (
        <ScatterPlot
          rows={sourceRows}
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
          xIsDate={xIsDate}
          yIsDate={yIsDate}
          xAxisStartZero={xAxisStartZero}
          decimals={decimals}
        />
      )}
      {plotType === 'line' && (
        <LinePlot
          rows={sourceRows}
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
          xIsDate={xIsDate}
          xAxisStartZero={xAxisStartZero}
          decimals={decimals}
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
          decimals={decimals}
        />
      )}
      {plotType === 'histogram' && (
        <HistogramPlot
          rows={sourceRows}
          xCol={xCol!}
          groupCol={groupCol}
          groupNames={groupNames}
          colors={colors}
          binMode={binMode}
          binsConfig={binsConfig}
          binWidthConfig={binWidthConfig}
          opacity={opacity}
          xLabel={resolvedXLabel}
          showGrid={showGrid}
          showLegend={showLegend}
          legendPosition={legendPosition}
          barMode={barMode}
          xAxisStartZero={xAxisStartZero}
          decimals={decimals}
        />
      )}
      {plotType === 'boxplot' && (
        <BoxViolinPlot
          rows={sourceRows}
          xCol={xCol!}
          yCol={yCol}
          colors={colors}
          opacity={opacity}
          yLabel={resolvedYLabel}
          showGrid={showGrid}
          violin={false}
        />
      )}
      {plotType === 'violin' && (
        <BoxViolinPlot
          rows={sourceRows}
          xCol={xCol!}
          yCol={yCol}
          colors={colors}
          opacity={opacity}
          yLabel={resolvedYLabel}
          showGrid={showGrid}
          violin={true}
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

  const titleElement = resolvedTitle ? (
    <span className={cn(
      'text-xs font-medium truncate',
      titleColor ? titleColor.text : 'text-muted-foreground',
      !compact && !titleColor && 'text-sm text-foreground/80',
    )} style={titleColor?.isCustom ? { color: titleColor.hex } : undefined}>
      {resolvedTitle}
    </span>
  ) : null

  const header = (Icon || titleElement) ? (
    <div className={cn(
      'flex items-center gap-2',
      compact ? 'px-4 pt-3 pb-1' : 'mb-2',
      centerTitle && 'justify-center',
    )}>
      {Icon && (
        <Icon
          size={compact ? 16 : 18}
          className={hasCardColor ? color.text : 'text-muted-foreground'}
          style={color.isCustom ? { color: color.hex } : undefined}
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

function ScatterPlot({
  rows, xCol, yCol, groupCol, groupNames, colors, pointSize, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, xIsDate, yIsDate, xAxisStartZero, decimals = 1,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; pointSize: number; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; xIsDate?: boolean; yIsDate?: boolean; xAxisStartZero?: boolean; decimals?: number
}) {
  const legendProps = buildLegendProps(legendPosition)
  const data = useMemo(() => {
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
  }, [rows, xCol, yCol, groupCol, groupNames])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" name={xLabel || undefined} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} tickFormatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} domain={xAxisStartZero ? [0, 'auto'] : undefined} />
        <YAxis dataKey="y" type="number" name={yLabel || undefined} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} tickFormatter={yIsDate ? formatDateTick : formatNumericTick(decimals)} />
        <Tooltip
          {...TOOLTIP_STYLE}
          cursor={{ strokeDasharray: '3 3' }}
          formatter={(_v: unknown, name: string, props: { payload?: { x?: number; y?: number } }) => {
            if (name === 'x' && xIsDate && props.payload?.x) return formatDateTick(props.payload.x)
            if (name === 'y' && yIsDate && props.payload?.y) return formatDateTick(props.payload.y)
            return String(_v)
          }}
        />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} {...legendProps} />}
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
  rows, xCol, yCol, groupCol, groupNames, colors, pointSize, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, xIsDate, xAxisStartZero, decimals = 1,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; pointSize: number; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; xIsDate?: boolean; xAxisStartZero?: boolean; decimals?: number
}) {
  const legendProps = buildLegendProps(legendPosition)
  const { merged, series } = useMemo(() => {
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
  }, [rows, xCol, yCol, groupCol, groupNames])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={merged} margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} tickFormatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} domain={xAxisStartZero ? [0, 'auto'] : undefined} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} tickFormatter={formatNumericTick(decimals)} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={xIsDate ? formatDateTick : undefined} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} {...legendProps} />}
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
  rows, xCol, yCol, groupCol, groupNames, colors, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, decimals = 1,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol?: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; decimals?: number
}) {
  const legendProps = buildLegendProps(legendPosition)
  const isCountMode = !yCol
  const dataKey = isCountMode ? 'count' : 'value'

  const { data, series } = useMemo(() => {
    if (yCol) {
      if (!groupNames || !groupCol) {
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
        const data = Array.from(map.entries())
          .slice(0, 30)
          .map(([name, { sum, count }]) => ({ name, value: sum / count }))
        return { data, series: ['value'] }
      }
      const map = new Map<string, Record<string, { sum: number; count: number }>>()
      for (const row of rows) {
        const key = String(row[xCol] ?? '')
        const g = String(row[groupCol] ?? '')
        const val = toNumeric(row[yCol])
        if (isNaN(val)) continue
        if (!map.has(key)) map.set(key, {})
        const inner = map.get(key)!
        if (!inner[g]) inner[g] = { sum: 0, count: 0 }
        inner[g].sum += val
        inner[g].count++
      }
      const data = Array.from(map.entries())
        .slice(0, 30)
        .map(([name, groups]) => {
          const entry: Record<string, unknown> = { name }
          for (const g of groupNames) {
            const agg = groups[g]
            entry[g] = agg ? agg.sum / agg.count : 0
          }
          return entry
        })
      return { data, series: groupNames }
    }
    if (!groupNames || !groupCol) {
      const counts = new Map<string, number>()
      for (const row of rows) {
        const key = String(row[xCol] ?? '')
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const data = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([name, count]) => ({ name, count }))
      return { data, series: ['count'] }
    }
    const map = new Map<string, Record<string, number>>()
    for (const row of rows) {
      const key = String(row[xCol] ?? '')
      const g = String(row[groupCol] ?? '')
      if (!map.has(key)) map.set(key, {})
      const inner = map.get(key)!
      inner[g] = (inner[g] ?? 0) + 1
    }
    const data = Array.from(map.entries())
      .slice(0, 30)
      .map(([name, groups]) => {
        const entry: Record<string, unknown> = { name }
        for (const g of groupNames) entry[g] = groups[g] ?? 0
        return entry
      })
    return { data, series: groupNames }
  }, [rows, xCol, yCol, groupCol, groupNames])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="name" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedTick maxLen={20} angle={-30} textAnchor="end" />} interval={0} height={60} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} tickFormatter={formatNumericTick(decimals)} />
        <Tooltip {...TOOLTIP_STYLE} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} {...legendProps} />}
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} name={s === dataKey ? undefined : s} fill={colors[i % colors.length]} fillOpacity={opacity} radius={[2, 2, 0, 0]} activeBar={{ fillOpacity: Math.min(1, opacity + 0.2), stroke: colors[i % colors.length], strokeWidth: 1 }} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Histogram (with grouped bar modes: grouped / stacked / overlay)
// ---------------------------------------------------------------------------

function HistogramPlot({
  rows, xCol, groupCol, groupNames, colors, binMode, binsConfig, binWidthConfig, opacity, xLabel, showGrid, showLegend, legendPosition, barMode, xAxisStartZero, decimals = 1,
}: {
  rows: Record<string, unknown>[]; xCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; binMode: string; binsConfig: number; binWidthConfig: number; opacity: number; xLabel: string
  showGrid: boolean; showLegend: boolean; legendPosition: string; barMode: string; xAxisStartZero?: boolean; decimals?: number
}) {
  const { data, series, effectiveBins } = useMemo(() => {
    if (!groupNames || !groupCol) {
      const values = rows.map(r => toNumeric(r[xCol])).filter(v => !isNaN(v))
      const d = buildHistogramData(values, binMode, binsConfig, binWidthConfig, xAxisStartZero, decimals)
      return { data: d, series: ['count'], effectiveBins: d.length }
    }
    const d = buildHistogramGrouped(rows, xCol, groupCol, binMode, binsConfig, binWidthConfig, groupNames, xAxisStartZero, decimals)
    return { data: d, series: groupNames, effectiveBins: d.length }
  }, [rows, xCol, groupCol, groupNames, binMode, binsConfig, binWidthConfig, xAxisStartZero, decimals])

  const hasGroups = groupNames != null && groupNames.length > 1
  const isOverlay = barMode === 'overlay' && hasGroups
  const isStacked = barMode === 'stacked' && hasGroups
  const effectiveOpacity = isOverlay ? Math.min(opacity, 0.5) : opacity
  const legendProps = buildLegendProps(legendPosition)

  // Total count for proportion calculation
  const totalCount = useMemo(() => {
    let total = 0
    for (const d of data) {
      for (const s of series) {
        total += (d[s] as number) ?? 0
      }
    }
    return total
  }, [data, series])

  const renderHistTooltip = useCallback(({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
    if (!active || !payload?.length) return null
    return (
      <div style={{ fontSize: 10, padding: '6px 10px', background: 'rgba(0,0,0,.85)', borderRadius: 4, color: '#fff', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
        {payload.map((p, i) => {
          const pct = totalCount > 0 ? ((p.value / totalCount) * 100).toFixed(1) : '0'
          return (
            <div key={i}>
              {hasGroups && <span style={{ color: p.color }}>{p.name}: </span>}
              <span>Count: {p.value.toLocaleString()}</span>
              <span style={{ marginLeft: 8, opacity: 0.7 }}>({pct}%)</span>
            </div>
          )
        })}
      </div>
    )
  }, [totalCount, hasGroups])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        margin={{ top: 5, right: 20, bottom: 25, left: 10 }}
        {...(isOverlay ? { barGap: '-100%' } : {})}
      >
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="bin" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedTick maxLen={12} />} interval={Math.max(0, Math.floor(effectiveBins / 10) - 1)} />
        <YAxis label={{ value: 'Count', angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <Tooltip content={renderHistTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} {...legendProps} />}
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            name={s === 'count' ? undefined : s}
            fill={colors[i % colors.length]}
            fillOpacity={effectiveOpacity}
            radius={[2, 2, 0, 0]}
            stackId={isStacked ? 'stack' : undefined}
            activeBar={{ fillOpacity: Math.min(1, effectiveOpacity + 0.2), stroke: colors[i % colors.length], strokeWidth: 1 }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Boxplot / Violin
// ---------------------------------------------------------------------------

function BoxViolinPlot({
  rows, xCol, yCol, colors, opacity, yLabel, showGrid, violin,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol?: string
  colors: string[]; opacity: number; yLabel: string; showGrid: boolean; violin: boolean
}) {
  const data = useMemo<BoxplotData[]>(() => {
    const valCol = yCol ?? xCol
    const catCol = yCol ? xCol : null

    if (!catCol) {
      const values = rows.map(r => toNumeric(r[valCol])).filter(v => !isNaN(v))
      const stats = computeBoxplotStats(values)
      if (!stats) return []
      return [{ name: valCol, stats, values }]
    }

    const groups = new Map<string, number[]>()
    for (const row of rows) {
      const cat = String(row[catCol] ?? '')
      const val = toNumeric(row[valCol])
      if (isNaN(val)) continue
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(val)
    }

    const result: BoxplotData[] = []
    for (const [name, values] of Array.from(groups.entries()).slice(0, 20)) {
      const stats = computeBoxplotStats(values)
      if (stats) result.push({ name, stats, values })
    }
    return result
  }, [rows, xCol, yCol])

  return (
    <div className="w-full h-full">
      <BoxplotChart
        data={data}
        colors={colors}
        opacity={opacity}
        yLabel={yLabel}
        showGrid={showGrid}
        violin={violin}
      />
    </div>
  )
}
