import type { DatasetColumn } from '@/types'

export interface KeyIndicatorSpec {
  column: { name: string; numeric: boolean } | null
  uniquePer: string | null
  uniqueAggregation: string
  aggregate: string
  targetValue: string
  excludeNA: boolean
  chartType: string
  chartBins: number
  xAxisStartZero: boolean
  decimals: number
}

/**
 * Build the Key Indicator render SPEC (chosen column → name+numeric, aggregation
 * options, chart settings) sent to POST /execute/render. The server owns the
 * pandas program that turns this into the same KeyIndicatorData JSON the client
 * computes from rows — so a viewer can render it without the server running any
 * client-supplied code. Server parity:
 * apps/api/app/services/execution/render/key_indicator.py (_KPI_PY).
 */
export function buildKeyIndicatorSpec(
  columns: DatasetColumn[],
  config: Record<string, unknown>,
): KeyIndicatorSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const columnId = config.column as string | undefined
  const col = columnId ? byId.get(columnId) : undefined
  const uniquePerId = config.uniquePer as string | undefined
  const uniquePer = uniquePerId ? byId.get(uniquePerId) : undefined

  return {
    column: col ? { name: col.name, numeric: col.type === 'number' } : null,
    uniquePer: uniquePer ? uniquePer.name : null,
    uniqueAggregation: (config.uniqueAggregation as string) ?? 'first',
    aggregate: (config.aggregate as string) ?? 'mean',
    targetValue: (config.targetValue as string | undefined) ?? '',
    excludeNA: (config.excludeNA as boolean) ?? true,
    chartType: (config.chartType as string) ?? 'none',
    chartBins: (config.chartBins as number) ?? 15,
    xAxisStartZero: (config.xAxisStartZero as boolean) ?? false,
    decimals: (config.decimals as number | undefined) ?? 1,
  }
}
