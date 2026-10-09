import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { niceTicks } from '@/lib/chart-ticks'
import { TOOLTIP_STYLE, CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { TruncatedTick } from './chart-axis-helpers'
import { orderCategories, type CategoryOrder } from './plot-category-order'
import { formatNumericTick, NO_CUSTOM_ORDER, toNumeric, type PlotServerData } from './plot-builder-shared'
import { buildLegendProps } from './plot-builder-legend'

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------

export function BarPlot({
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
