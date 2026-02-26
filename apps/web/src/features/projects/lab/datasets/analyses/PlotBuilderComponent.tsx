import { useMemo } from 'react'
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
  Cell,
} from 'recharts'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const PALETTES: Record<string, string[]> = {
  default: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'],
  pastel: ['#aec7e8', '#ffbb78', '#ff9896', '#98df8a', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5'],
  vivid: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999', '#66c2a5', '#fc8d62'],
  monochrome: ['#252525', '#525252', '#737373', '#969696', '#bdbdbd', '#d9d9d9', '#636363', '#a8a8a8', '#454545', '#cccccc'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHistogramData(values: number[], bins: number) {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ bin: String(min), count: values.length }]
  const binWidth = (max - min) / bins
  const buckets: { bin: string; count: number }[] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * binWidth
    const hi = lo + binWidth
    buckets.push({ bin: `${lo.toPrecision(3)}`, count: 0 })
    for (const v of values) {
      if (i < bins - 1 ? v >= lo && v < hi : v >= lo && v <= hi) {
        buckets[i].count++
      }
    }
  }
  return buckets
}

function buildHistogramGrouped(
  rows: Record<string, unknown>[],
  xCol: string,
  groupCol: string,
  bins: number,
  groupNames: string[],
) {
  const allVals = rows.map(r => Number(r[xCol])).filter(v => !isNaN(v))
  if (allVals.length === 0) return []
  const min = Math.min(...allVals)
  const max = Math.max(...allVals)
  if (min === max) return [{ bin: String(min), ...Object.fromEntries(groupNames.map(g => [g, 0])) }]
  const binWidth = (max - min) / bins

  const buckets: Record<string, unknown>[] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * binWidth
    const entry: Record<string, unknown> = { bin: `${lo.toPrecision(3)}` }
    for (const g of groupNames) entry[g] = 0
    buckets.push(entry)
  }

  for (const row of rows) {
    const v = Number(row[xCol])
    if (isNaN(v)) continue
    let idx = Math.floor((v - min) / binWidth)
    if (idx >= bins) idx = bins - 1
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
// Boxplot / Violin sub-component (custom SVG — Recharts has no built-in)
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

  // Y-axis ticks
  const tickCount = 6
  const yTicks: number[] = []
  for (let i = 0; i <= tickCount; i++) {
    yTicks.push(plotMin + (plotRange * i) / tickCount)
  }

  // Density kernel for violin
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
      {/* Grid lines */}
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

      {/* Y axis */}
      <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={marginTop + plotH} stroke="currentColor" strokeOpacity={0.2} />
      {yTicks.map((tick, i) => (
        <text key={i} x={marginLeft - 8} y={toY(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.6}>
          {tick.toPrecision(3)}
        </text>
      ))}

      {/* Y label */}
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

      {/* Boxes */}
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
              {/* Median line */}
              <line x1={cx - halfW * 0.4} x2={cx + halfW * 0.4} y1={toY(median)} y2={toY(median)} stroke="white" strokeWidth={2} />
              {/* Category label */}
              <text x={cx} y={height - marginBottom + 20} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.7}>
                {d.name.length > 12 ? d.name.slice(0, 11) + '…' : d.name}
              </text>
            </g>
          )
        }

        const halfBox = boxWidth / 2
        return (
          <g key={i}>
            {/* Whisker line */}
            <line x1={cx} x2={cx} y1={toY(max)} y2={toY(min)} stroke={color} strokeWidth={1.5} strokeOpacity={0.5} />
            {/* Whisker caps */}
            <line x1={cx - halfBox * 0.4} x2={cx + halfBox * 0.4} y1={toY(max)} y2={toY(max)} stroke={color} strokeWidth={1.5} />
            <line x1={cx - halfBox * 0.4} x2={cx + halfBox * 0.4} y1={toY(min)} y2={toY(min)} stroke={color} strokeWidth={1.5} />
            {/* Box */}
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
            {/* Median */}
            <line x1={cx - halfBox} x2={cx + halfBox} y1={toY(median)} y2={toY(median)} stroke="white" strokeWidth={2} />
            {/* Category label */}
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
// Main component
// ---------------------------------------------------------------------------

export function PlotBuilderComponent({ config, columns, rows }: ComponentPluginProps) {
  const { t } = useTranslation()

  const plotType = (config.plotType as string) ?? 'scatter'
  const xCol = config.xColumn as string | undefined
  const yCol = config.yColumn as string | undefined
  const groupCol = config.groupColumn as string | undefined
  const bins = (config.bins as number) ?? 20
  const pointSize = (config.pointSize as number) ?? 4
  const opacityPct = (config.opacity as number) ?? 70
  const paletteName = (config.colorPalette as string) ?? 'default'
  const chartTitle = (config.title as string) ?? ''
  const xLabel = (config.xLabel as string) ?? ''
  const yLabel = (config.yLabel as string) ?? ''
  const showGrid = (config.showGrid as boolean) ?? true
  const showLegend = (config.showLegend as boolean) ?? true

  const opacity = opacityPct / 100
  const colors = PALETTES[paletteName] ?? PALETTES.default

  // Resolve group names
  const groupNames = useMemo(() => {
    if (!groupCol || !columns.find(c => c.id === groupCol)) return null
    const set = new Set<string>()
    for (const row of rows) {
      const v = row[groupCol]
      if (v != null) set.add(String(v))
    }
    return Array.from(set).sort()
  }, [groupCol, columns, rows])

  // Validate
  const xColumn = columns.find(c => c.id === xCol)
  const yColumn = columns.find(c => c.id === yCol)

  const resolvedXLabel = xLabel || xColumn?.name || xCol || 'X'
  const resolvedYLabel = yLabel || yColumn?.name || yCol || 'Y'
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

  if (plotType !== 'histogram' && !yColumn) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.plot_builder_select_y', 'Select a Y variable.')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-4 gap-2">
      {/* Title */}
      {resolvedTitle && (
        <div className="text-sm font-medium text-center text-foreground/80 pb-1">{resolvedTitle}</div>
      )}

      {/* Chart area */}
      <div className="flex-1 min-h-0">
        {plotType === 'scatter' && (
          <ScatterPlot
            rows={rows}
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
          />
        )}
        {plotType === 'line' && (
          <LinePlot
            rows={rows}
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
          />
        )}
        {plotType === 'bar' && (
          <BarPlot
            rows={rows}
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
          />
        )}
        {plotType === 'histogram' && (
          <HistogramPlot
            rows={rows}
            xCol={xCol!}
            groupCol={groupCol}
            groupNames={groupNames}
            colors={colors}
            bins={bins}
            opacity={opacity}
            xLabel={resolvedXLabel}
            showGrid={showGrid}
            showLegend={showLegend}
          />
        )}
        {plotType === 'boxplot' && (
          <BoxViolinPlot
            rows={rows}
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
            rows={rows}
            xCol={xCol!}
            yCol={yCol}
            colors={colors}
            opacity={opacity}
            yLabel={resolvedYLabel}
            showGrid={showGrid}
            violin={true}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

function ScatterPlot({
  rows, xCol, yCol, groupCol, groupNames, colors, pointSize, opacity, xLabel, yLabel, showGrid, showLegend,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; pointSize: number; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
}) {
  const data = useMemo(() => {
    if (!groupNames || !groupCol) {
      return [{
        name: 'all',
        data: rows
          .map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) }))
          .filter(d => !isNaN(d.x) && !isNaN(d.y)),
      }]
    }
    return groupNames.map(g => ({
      name: g,
      data: rows
        .filter(r => String(r[groupCol]) === g)
        .map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) }))
        .filter(d => !isNaN(d.x) && !isNaN(d.y)),
    }))
  }, [rows, xCol, yCol, groupCol, groupNames])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="x" type="number" name={xLabel} label={{ value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <YAxis dataKey="y" type="number" name={yLabel} label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ fontSize: 11, background: 'rgba(0,0,0,.85)', border: 'none', borderRadius: 4, color: '#fff' }} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} />}
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
  rows, xCol, yCol, groupCol, groupNames, colors, pointSize, opacity, xLabel, yLabel, showGrid, showLegend,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; pointSize: number; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
}) {
  const { merged, series } = useMemo(() => {
    // Build a merged dataset keyed on x values
    if (!groupNames || !groupCol) {
      const sorted = rows
        .map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) }))
        .filter(d => !isNaN(d.x) && !isNaN(d.y))
        .sort((a, b) => a.x - b.x)
      return { merged: sorted.map(d => ({ x: d.x, all: d.y })), series: ['all'] }
    }

    // Grouped: merge into a single array sorted by x, with one key per group
    const map = new Map<number, Record<string, unknown>>()
    for (const row of rows) {
      const xVal = Number(row[xCol])
      const yVal = Number(row[yCol])
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
        <XAxis dataKey="x" type="number" label={{ value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <Tooltip contentStyle={{ fontSize: 11, background: 'rgba(0,0,0,.85)', border: 'none', borderRadius: 4, color: '#fff' }} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} />}
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
  rows, xCol, yCol, groupCol, groupNames, colors, opacity, xLabel, yLabel, showGrid, showLegend,
}: {
  rows: Record<string, unknown>[]; xCol: string; yCol?: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; opacity: number; xLabel: string; yLabel: string; showGrid: boolean; showLegend: boolean
}) {
  const { data, series } = useMemo(() => {
    if (yCol) {
      // Numeric Y: aggregate by X (and optional group)
      if (!groupNames || !groupCol) {
        const map = new Map<string, { sum: number; count: number }>()
        for (const row of rows) {
          const key = String(row[xCol] ?? '')
          const val = Number(row[yCol])
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
      // Grouped + numeric Y
      const map = new Map<string, Record<string, { sum: number; count: number }>>()
      for (const row of rows) {
        const key = String(row[xCol] ?? '')
        const g = String(row[groupCol] ?? '')
        const val = Number(row[yCol])
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
    // No Y: count occurrences
    if (!groupNames || !groupCol) {
      const counts = new Map<string, number>()
      for (const row of rows) {
        const key = String(row[xCol] ?? '')
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const data = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([name, count]) => ({ name, value: count }))
      return { data, series: ['value'] }
    }
    // Grouped counts
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
        <XAxis dataKey="name" label={{ value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 }} tick={{ fontSize: 9 }} interval={0} angle={-30} textAnchor="end" height={60} />
        <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <Tooltip contentStyle={{ fontSize: 11, background: 'rgba(0,0,0,.85)', border: 'none', borderRadius: 4, color: '#fff' }} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} name={s === 'value' ? undefined : s} fill={colors[i % colors.length]} fillOpacity={opacity} radius={[2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

function HistogramPlot({
  rows, xCol, groupCol, groupNames, colors, bins, opacity, xLabel, showGrid, showLegend,
}: {
  rows: Record<string, unknown>[]; xCol: string; groupCol?: string; groupNames: string[] | null
  colors: string[]; bins: number; opacity: number; xLabel: string; showGrid: boolean; showLegend: boolean
}) {
  const { data, series } = useMemo(() => {
    if (!groupNames || !groupCol) {
      const values = rows.map(r => Number(r[xCol])).filter(v => !isNaN(v))
      return { data: buildHistogramData(values, bins), series: ['count'] }
    }
    const data = buildHistogramGrouped(rows, xCol, groupCol, bins, groupNames)
    return { data, series: groupNames }
  }, [rows, xCol, groupCol, groupNames, bins])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis dataKey="bin" label={{ value: xLabel, position: 'insideBottom', offset: -5, fontSize: 11 }} tick={{ fontSize: 9 }} interval={Math.max(0, Math.floor(bins / 10) - 1)} />
        <YAxis label={{ value: 'Count', angle: -90, position: 'insideLeft', offset: 5, fontSize: 11 }} tick={{ fontSize: 10 }} />
        <Tooltip contentStyle={{ fontSize: 11, background: 'rgba(0,0,0,.85)', border: 'none', borderRadius: 4, color: '#fff' }} />
        {showLegend && groupNames && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} name={s === 'count' ? undefined : s} fill={colors[i % colors.length]} fillOpacity={opacity} radius={[2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Boxplot / Violin (custom SVG)
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
      const values = rows.map(r => Number(r[valCol])).filter(v => !isNaN(v))
      const stats = computeBoxplotStats(values)
      if (!stats) return []
      return [{ name: valCol, stats, values }]
    }

    const groups = new Map<string, number[]>()
    for (const row of rows) {
      const cat = String(row[catCol] ?? '')
      const val = Number(row[valCol])
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
