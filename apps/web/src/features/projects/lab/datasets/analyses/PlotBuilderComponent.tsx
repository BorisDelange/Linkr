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
import { resolveColor, getLucideIcon, TOOLTIP_STYLE, aggregateByEntity, CHART_PALETTES, resolvePalette } from '@/lib/plugins/shared-styles'
import { TruncatedTick, TruncatedNumericTick, CategoryAxisLabel } from './chart-axis-helpers'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'


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
    // useGrouping spells out large numbers (4380) instead of scientific notation (4.38e+3)
    if (Number.isInteger(n)) return n.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true })
  }
}

/** Boxplot/violin Y-axis tick: ~3 significant digits, grouped thousands, never scientific notation.
 *  Replaces toPrecision(3) which emits "1.62e+3" for values ≥ 1000. */
function formatBoxTick(val: number): string {
  if (!isFinite(val)) return String(val)
  const abs = Math.abs(val)
  // Integers and large magnitudes: drop the fraction; small magnitudes: keep a few sig-figs.
  const maxFrac = abs >= 100 || Number.isInteger(val) ? 0 : abs >= 1 ? 2 : 4
  return val.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: maxFrac })
}

/** Round a step up to a "nice" 1/2/5×10ⁿ value. */
function niceStep(rough: number): number {
  if (rough <= 0 || !isFinite(rough)) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}

/**
 * Compute a "nice" axis domain and round tick values (e.g. 1500, 2000, 2500) for a
 * data range, so recharts doesn't pick ugly ticks like 1615, 2076. Returns null for
 * empty/degenerate data (caller falls back to recharts defaults).
 */
function niceTicks(values: number[], startAtZero = false, targetTicks = 6): { domain: [number, number]; ticks: number[] } | null {
  const finite = values.filter(v => isFinite(v))
  if (finite.length === 0) return null
  let lo = Math.min(...finite)
  let hi = Math.max(...finite)
  if (startAtZero && lo > 0) lo = 0
  if (startAtZero && hi < 0) hi = 0
  if (lo === hi) { lo -= 1; hi += 1 }
  const step = niceStep((hi - lo) / Math.max(1, targetTicks - 1))
  const niceLo = Math.floor(lo / step) * step
  const niceHi = Math.ceil(hi / step) * step
  // Round to the step's decimal precision to avoid float drift (e.g. 0.6000000000000001).
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  const round = (v: number) => Number(v.toFixed(decimals + 1))
  const ticks: number[] = []
  for (let i = 0; niceLo + i * step <= niceHi + step * 1e-9; i++) ticks.push(round(niceLo + i * step))
  return { domain: [round(niceLo), round(niceHi)], ticks }
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

/** Count occurrences of each unique category value, sorted by descending count. */
function buildCategoricalData(rows: Record<string, unknown>[], col: string) {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const v = r[col]
    if (v == null || v === '') continue
    const key = String(v)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([bin, count]) => ({ bin, count }))
}

/** Count occurrences of each category, split by group. */
function buildCategoricalGrouped(rows: Record<string, unknown>[], col: string, groupCol: string, groupNames: string[]) {
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
  return Array.from(counts.entries())
    .sort((a, b) => {
      const ta = groupNames.reduce((s, n) => s + a[1][n], 0)
      const tb = groupNames.reduce((s, n) => s + b[1][n], 0)
      return tb - ta
    })
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
  startAtZero = false,
  xLabelMaxLen = 12,
}: {
  data: BoxplotData[]
  colors: string[]
  opacity: number
  yLabel: string
  showGrid: boolean
  violin: boolean
  startAtZero?: boolean
  xLabelMaxLen?: number
}) {
  const { t } = useTranslation()
  if (data.length === 0) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">{t('datasets.no_data_available')}</div>

  const allMin = Math.min(...data.map(d => d.stats.min))
  const allMax = Math.max(...data.map(d => d.stats.max))

  // Nice rounded domain + ticks (e.g. 1500, 2000) rather than raw data bounds.
  const scale = niceTicks([allMin, allMax], startAtZero)
  const plotMin = scale ? scale.domain[0] : allMin - 1
  const plotMax = scale ? scale.domain[1] : allMax + 1
  const plotRange = plotMax - plotMin || 1
  const yTicks = scale ? scale.ticks : [plotMin, plotMax]

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
          {formatBoxTick(tick)}
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
              <CategoryAxisLabel x={cx} y={height - marginBottom + 20} name={d.name} maxLen={xLabelMaxLen} />
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
            <CategoryAxisLabel x={cx} y={height - marginBottom + 20} name={d.name} maxLen={xLabelMaxLen} />
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
  const iconColorName = (config.iconColor as string) ?? 'auto'
  const centerTitle = (config.centerTitle as boolean) ?? true
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
  const histogramOrientation = (config.histogramOrientation as string) ?? 'vertical'
  const excludeNA = (config.excludeNA as boolean) ?? true
  const pointSize = (config.pointSize as number) ?? 4
  const opacityPct = (config.opacity as number) ?? 70
  const xLabelMaxLen = (config.xLabelMaxLen as number) ?? 20
  const yLabelMaxLen = (config.yLabelMaxLen as number) ?? 16
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

  // For a horizontal histogram the binned variable comes from Y (X is unused); vertical uses X.
  const isHorizontalHistogram = plotType === 'histogram' && histogramOrientation === 'horizontal'
  const histogramCol = isHorizontalHistogram ? yCol : xCol
  const histogramColumn = isHorizontalHistogram ? yColumn : xColumn

  const resolvedXLabel = xLabel || ''
  const resolvedYLabel = yLabel || ''
  const resolvedTitle =
    chartTitle ||
    (plotType === 'histogram'
      ? `${t('datasets.plot_builder_histogram', 'Histogram')}: ${histogramColumn?.name ?? histogramCol ?? ''}`
      : `${xColumn?.name ?? xCol ?? ''} vs ${yColumn?.name ?? yCol ?? ''}`)

  // Histogram requires its binned variable (Y when horizontal, X otherwise); other plots require X.
  if (plotType === 'histogram' ? !histogramColumn : !xColumn) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {isHorizontalHistogram
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

  // Box/violin compute stats over a numeric value column (Y if given, else X). A categorical
  // value column coerces to NaN for every row and renders "No data" — say why instead.
  if (plotType === 'boxplot' || plotType === 'violin') {
    const valueColumn = yColumn ?? xColumn
    if (valueColumn && valueColumn.type !== 'number') {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
          {t('datasets.plot_builder_value_must_be_numeric', {
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
          xLabelMaxLen={xLabelMaxLen}
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
          barMode={barMode}
          orientation={histogramOrientation}
          xAxisStartZero={xAxisStartZero}
          decimals={decimals}
          xLabelMaxLen={xLabelMaxLen}
          yLabelMaxLen={yLabelMaxLen}
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
          startAtZero={xAxisStartZero}
          xLabelMaxLen={xLabelMaxLen}
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
          startAtZero={xAxisStartZero}
          xLabelMaxLen={xLabelMaxLen}
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

  // Nice rounded domains/ticks for numeric (non-date) axes.
  const xScale = useMemo(() => xIsDate ? null : niceTicks(data.flatMap(s => s.data.map(d => d.x)), xAxisStartZero), [data, xIsDate, xAxisStartZero])
  const yScale = useMemo(() => yIsDate ? null : niceTicks(data.flatMap(s => s.data.map(d => d.y))), [data, yIsDate])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" name={xLabel || undefined} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedNumericTick formatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} />} height={28} tickFormatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} domain={xScale ? xScale.domain : (xAxisStartZero ? [0, 'auto'] : undefined)} ticks={xScale?.ticks} />
        <YAxis dataKey="y" type="number" name={yLabel || undefined} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} width={56} tickFormatter={yIsDate ? formatDateTick : formatNumericTick(decimals)} domain={yScale ? yScale.domain : undefined} ticks={yScale?.ticks} />
        <Tooltip
          {...TOOLTIP_STYLE}
          cursor={{ strokeDasharray: '3 3' }}
          formatter={(_v: unknown, name: string, props: { payload?: { x?: number; y?: number } }) => {
            if (name === 'x' && xIsDate && props.payload?.x) return formatDateTick(props.payload.x)
            if (name === 'y' && yIsDate && props.payload?.y) return formatDateTick(props.payload.y)
            return typeof _v === 'number' ? formatNumericTick(decimals)(_v) : String(_v)
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

  const xScale = useMemo(() => xIsDate ? null : niceTicks(merged.map(d => d.x as number), xAxisStartZero), [merged, xIsDate, xAxisStartZero])
  const yScale = useMemo(() => {
    const ys: number[] = []
    for (const row of merged) for (const s of series) { const v = row[s]; if (typeof v === 'number') ys.push(v) }
    return niceTicks(ys)
  }, [merged, series])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={merged} margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedNumericTick formatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} />} height={28} tickFormatter={xIsDate ? formatDateTick : formatNumericTick(decimals)} domain={xScale ? xScale.domain : (xAxisStartZero ? [0, 'auto'] : undefined)} ticks={xScale?.ticks} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} width={56} tickFormatter={formatNumericTick(decimals)} domain={yScale ? yScale.domain : undefined} ticks={yScale?.ticks} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={xIsDate ? formatDateTick : undefined}
          formatter={(v: unknown) => (typeof v === 'number' ? formatNumericTick(decimals)(v) : String(v))}
        />
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
  rows, xCol, yCol, groupCol, groupNames, colors, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, decimals = 1, xLabelMaxLen = 20,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol?: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
  legendPosition: string; decimals?: number; xLabelMaxLen?: number
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

  // Nice Y ticks starting at 0 — bar values are naturally anchored at the baseline.
  const yScale = useMemo(() => {
    const vals: number[] = [0]
    for (const row of data) for (const s of series) { const v = (row as Record<string, unknown>)[s]; if (typeof v === 'number') vals.push(v) }
    return niceTicks(vals, true)
  }, [data, series])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="name" label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 } : undefined} tick={<TruncatedTick maxLen={xLabelMaxLen} angle={-30} textAnchor="end" />} interval={0} height={60} />
        <YAxis label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 } : undefined} tick={{ fontSize: 10 }} width={56} tickFormatter={formatNumericTick(decimals)} domain={yScale ? yScale.domain : undefined} ticks={yScale?.ticks} />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: unknown) => {
            if (typeof v !== 'number') return String(v)
            // Count mode yields integers; only the averaged-value mode needs decimals.
            return isCountMode ? v.toLocaleString() : formatNumericTick(decimals)(v)
          }}
        />
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
  rows, xCol, groupCol, groupNames, colors, binMode, binsConfig, binWidthConfig, opacity, xLabel, yLabel, showGrid, showLegend, legendPosition, barMode, orientation, xAxisStartZero, decimals = 1, xLabelMaxLen = 12, yLabelMaxLen = 16,
}: {
  rows: Record<string, unknown>[]; xCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; binMode: string; binsConfig: number; binWidthConfig: number; opacity: number; xLabel: string; yLabel: string
  showGrid: boolean; showLegend: boolean; legendPosition: string; barMode: string; orientation: string; xAxisStartZero?: boolean; decimals?: number; xLabelMaxLen?: number; yLabelMaxLen?: number
}) {
  const isCategorical = useMemo(() => isCategoricalColumn(rows, xCol), [rows, xCol])

  const { data, series, effectiveBins } = useMemo(() => {
    if (isCategorical) {
      if (!groupNames || !groupCol) {
        const d = buildCategoricalData(rows, xCol)
        return { data: d, series: ['count'], effectiveBins: d.length }
      }
      const d = buildCategoricalGrouped(rows, xCol, groupCol, groupNames)
      return { data: d, series: groupNames, effectiveBins: d.length }
    }
    if (!groupNames || !groupCol) {
      const values = rows.map(r => toNumeric(r[xCol])).filter(v => !isNaN(v))
      const d = buildHistogramData(values, binMode, binsConfig, binWidthConfig, xAxisStartZero, decimals)
      return { data: d, series: ['count'], effectiveBins: d.length }
    }
    const d = buildHistogramGrouped(rows, xCol, groupCol, binMode, binsConfig, binWidthConfig, groupNames, xAxisStartZero, decimals)
    return { data: d, series: groupNames, effectiveBins: d.length }
  }, [isCategorical, rows, xCol, groupCol, groupNames, binMode, binsConfig, binWidthConfig, xAxisStartZero, decimals])

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

  const isHorizontal = orientation === 'horizontal'
  // X axis label always labels the bottom (X-screen) axis; Y axis label the left (Y-screen) axis —
  // regardless of orientation. The count axis is X-screen when horizontal, Y-screen when vertical.
  const binAxisLabel = isHorizontal ? yLabel : xLabel
  const countAxisLabel = isHorizontal ? xLabel : yLabel
  // Tooltip needs a word for the effectif; only fall back to "Count" there, never on the empty axis title.
  const countLabel = countAxisLabel || 'Count'
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
              <span>{countLabel}: {p.value.toLocaleString()}</span>
              <span style={{ marginLeft: 8, opacity: 0.7 }}>({pct}%)</span>
            </div>
          )
        })}
      </div>
    )
  }, [totalCount, hasGroups, countLabel])

  const tickInterval = Math.max(0, Math.floor(effectiveBins / 10) - 1)
  const barRadius: [number, number, number, number] = isHorizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]

  // Axes: in horizontal mode the category/bin axis is Y (vertical) and the count axis is X (horizontal).
  const binAxisProps = {
    dataKey: 'bin',
    label: binAxisLabel ? { value: binAxisLabel, ...(isHorizontal ? { angle: -90, position: 'insideLeft', offset: 5 } : { position: 'insideBottom', offset: -5 }), fontSize: 11 } : undefined,
    // On a horizontal chart the bin axis is vertical (Y): right-anchor labels left of the axis and vertically center them.
    tick: isHorizontal
      ? <TruncatedTick maxLen={yLabelMaxLen} textAnchor="end" dx={-4} dy={4} />
      : <TruncatedTick maxLen={xLabelMaxLen} />,
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
        for (const s of series) sum += (d[s] as number) ?? 0
        if (sum > max) max = sum
      } else {
        for (const s of series) { const v = (d[s] as number) ?? 0; if (v > max) max = v }
      }
    }
    return niceTicks([0, max], true)
  }, [data, series, isStacked])

  const countAxisProps = {
    label: countAxisLabel ? { value: countAxisLabel, ...(isHorizontal ? { position: 'insideBottom', offset: -5 } : { angle: -90, position: 'insideLeft', offset: 5 }), fontSize: 11 } : undefined,
    tick: { fontSize: 10 },
    tickFormatter: formatCountTick,
    allowDecimals: false,
    ...(countScale ? { domain: countScale.domain, ticks: countScale.ticks } : {}),
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout={isHorizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 5, right: 20, bottom: 25, left: 10 }}
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
            <XAxis {...binAxisProps} />
            <YAxis width={56} {...countAxisProps} />
          </>
        )}
        <Tooltip content={renderHistTooltip} cursor={{ fill: 'rgba(255,255,255,.15)' }} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} {...legendProps} />}
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            name={s === 'count' ? undefined : s}
            fill={colors[i % colors.length]}
            fillOpacity={effectiveOpacity}
            radius={barRadius}
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
  rows, xCol, yCol, colors, opacity, yLabel, showGrid, violin, startAtZero, xLabelMaxLen = 12,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol?: string
  colors: string[]; opacity: number; yLabel: string; showGrid: boolean; violin: boolean; startAtZero?: boolean; xLabelMaxLen?: number
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
        startAtZero={startAtZero}
        xLabelMaxLen={xLabelMaxLen}
      />
    </div>
  )
}
