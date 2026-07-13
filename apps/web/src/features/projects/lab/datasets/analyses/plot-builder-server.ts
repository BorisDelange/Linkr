import type { DatasetColumn } from '@/types'

export interface PlotBuilderSpec {
  plotType: string
  x: string | null
  y: string | null
  hist: string | null
  xType: string | null
  yType: string | null
  group: string | null
  uniquePer: string | null
  uniqueAggregation: string
  excludeNA: boolean
  binMode: string
  bins: number
  binWidth: number
  decimals: number
  xAxisStartZero: boolean
}

/**
 * Build the Plot Builder render SPEC (resolved column names + derived types +
 * plot options) sent to POST /execute/render. The server owns the pandas program
 * that turns this into the same PlotServerData JSON the sub-plots consume — so a
 * viewer can render it without the server running any client-supplied code.
 * Server parity: apps/api/app/services/execution/render/plot_builder.py (_PLOT_PY).
 */
export function buildPlotBuilderSpec(columns: DatasetColumn[], config: Record<string, unknown>): PlotBuilderSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const colName = (id: string | undefined): string | null => (id ? byId.get(id)?.name ?? null : null)
  const colType = (id: string | undefined): string | null => (id ? byId.get(id)?.type ?? null : null)

  const plotType = (config.plotType as string) ?? 'scatter'
  const histogramOrientation = (config.histogramOrientation as string) ?? 'vertical'
  const xId = config.xColumn as string | undefined
  const yId = config.yColumn as string | undefined
  const groupId = config.groupColumn as string | undefined
  const isHorizontalHistogram = plotType === 'histogram' && histogramOrientation === 'horizontal'
  const histId = isHorizontalHistogram ? yId : xId

  return {
    plotType,
    x: colName(xId),
    y: colName(yId),
    hist: colName(histId),
    xType: colType(xId),
    yType: colType(yId),
    group: groupId && byId.get(groupId) ? colName(groupId) : null,
    uniquePer: config.uniquePer ? colName(config.uniquePer as string) : null,
    uniqueAggregation: (config.uniqueAggregation as string) ?? 'first',
    excludeNA: (config.excludeNA as boolean) ?? true,
    binMode: (config.binMode as string) ?? 'count',
    bins: (config.bins as number) ?? 20,
    binWidth: (config.binWidth as number) ?? 5,
    decimals: (config.decimals as number) ?? 1,
    xAxisStartZero: (config.xAxisStartZero as boolean) ?? false,
  }
}
