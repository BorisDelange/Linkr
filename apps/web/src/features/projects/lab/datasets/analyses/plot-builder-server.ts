import type { DatasetColumn } from '@/types'
import { readCategoryOrder, readCustomCategoryOrder, type CategoryOrder } from './plot-category-order'

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
  outlierMethod: string
  outlierCoef: number
  binMode: string
  bins: number
  binWidth: number
  decimals: number
  xAxisStartZero: boolean
  /** Order of a categorical axis, applied before any category cap. Null = each plot
   *  path keeps its own default (value-desc for counts, data order for box/violin
   *  and for a bar chart that averages a Y or is split by a group). */
  categoryOrder: CategoryOrder | null
  /** `custom` only: the user's order of the category values. */
  categoryOrderCustom: string[]
  /** Histogram drag-to-zoom: re-bin only the values in this range, so zooming shows
   *  finer structure rather than the same bars drawn wider. Null when unzoomed. */
  zoomLo: number | null
  zoomHi: number | null
}

/**
 * Build the Plot Builder render SPEC (resolved column names + derived types +
 * plot options) sent to POST /execute/render. The server owns the pandas program
 * that turns this into the same PlotServerData JSON the sub-plots consume — so a
 * viewer can render it without the server running any client-supplied code.
 * Server parity: apps/api/app/services/execution/render/plot_builder.py (_PLOT_PY).
 */
export function buildPlotBuilderSpec(
  columns: DatasetColumn[],
  config: Record<string, unknown>,
  /** Live interaction state, not part of the saved widget config. */
  zoom?: { lo: number; hi: number } | null,
): PlotBuilderSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const plotType = (config.plotType as string) ?? 'scatter'
  const colName = (id: string | undefined): string | null => (id ? byId.get(id)?.name ?? null : null)
  const colType = (id: string | undefined): string | null => (id ? byId.get(id)?.type ?? null : null)

  const histogramOrientation = (config.histogramOrientation as string) ?? 'vertical'
  const isBoxLike = plotType === 'boxplot' || plotType === 'violin'
  // A horizontal box/violin has its columns swapped in the config (categories on Y,
  // values on X); swap them back so the server sees the usual x = categories, y = values.
  const swapBoxAxes = isBoxLike && config.boxplotOrientation === 'horizontal'
  const configX = config.xColumn as string | undefined
  const configY = config.yColumn as string | undefined
  const xId = swapBoxAxes ? configY : configX
  // A pie counts one variable: a Y left over from another plot type must not
  // filter its rows (excludeNA / outliers read Y).
  const yId = plotType === 'pie' ? undefined : swapBoxAxes ? configX : configY
  const groupId = config.groupColumn as string | undefined
  const isHorizontalHistogram = plotType === 'histogram' && histogramOrientation === 'horizontal'
  const histId = isHorizontalHistogram ? yId : xId
  const categoryOrder = readCategoryOrder(config)

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
    outlierMethod: (config.outlierMethod as string) ?? 'none',
    outlierCoef: (config.outlierCoef as number) ?? 1.5,
    binMode: (config.binMode as string) ?? 'count',
    bins: (config.bins as number) ?? 20,
    binWidth: (config.binWidth as number) ?? 5,
    decimals: (config.decimals as number) ?? 1,
    // Padding the axis down to 0 inside a zoom would drag the view back to the
    // origin and undo it, so it only applies unzoomed.
    xAxisStartZero: zoom ? false : ((config.xAxisStartZero as boolean) ?? false),
    categoryOrder,
    categoryOrderCustom: categoryOrder === 'custom' ? readCustomCategoryOrder(config) : [],
    zoomLo: zoom?.lo ?? null,
    zoomHi: zoom?.hi ?? null,
  }
}
