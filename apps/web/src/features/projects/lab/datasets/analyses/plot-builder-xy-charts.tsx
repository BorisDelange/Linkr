import { useMemo, useCallback } from 'react'
import { ResponsiveContainer, ScatterChart, Scatter, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { niceTicks } from '@/lib/chart-ticks'
import { TOOLTIP_STYLE, CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { TruncatedNumericTick } from './chart-axis-helpers'
import { ChartTooltipCard } from './chart-tooltip'
import { formatNumericTick, toNumeric, type PlotScatterSeries, type PlotServerData } from './plot-builder-shared'
import { formatDateTick } from './plot-builder-data'
import { buildLegendProps } from './plot-builder-legend'

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

export function ScatterPlot({
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

export function LinePlot({
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
