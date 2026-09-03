import type { DatasetColumn } from '@/types'
import type { SpcConfig } from '@/lib/spc/spc-compute'

/**
 * The SPC render spec sent to POST /execute/render.
 *
 * Column NAMES, never ids: the server holds the dataset as a DataFrame whose
 * columns are named, and it never sees the client's derived ids.
 *
 * Server parity: apps/api/app/services/execution/render/spc.py, which must print
 * the same SpcResult JSON that computeSpc() returns from rows — so a viewer in
 * server mode gets the identical chart without the server running any
 * client-supplied code.
 */
export interface SpcSpec {
  statisticType: string
  chartType: string
  date: string | null
  value: string | null
  period: string
  eventValues: string[] | null
  denominatorMode: string
  exposure: string | null
  admission: string | null
  discharge: string | null
  deviceStart: string | null
  deviceEnd: string | null
  deduplicateBy: string | null
  aggregation: string
  rateBasis: number
  sigmaWidth: number
  lambda: number
  target: number | null
  runsRules: string
  runLength: number
  baselineUntil: string | null
}

export function buildSpcSpec(columns: DatasetColumn[], config: SpcConfig): SpcSpec {
  const byId = new Map(columns.map(c => [c.id, c]))
  const name = (id: string | undefined) => (id ? (byId.get(id)?.name ?? null) : null)

  return {
    statisticType: config.statisticType,
    chartType: config.chartType,
    date: name(config.dateColumn),
    value: name(config.valueColumn),
    period: config.period,
    eventValues: config.eventValues && config.eventValues.length > 0 ? config.eventValues : null,
    denominatorMode: config.denominatorMode,
    exposure: name(config.exposureColumn),
    admission: name(config.admissionColumn),
    discharge: name(config.dischargeColumn),
    deviceStart: name(config.deviceStartColumn),
    deviceEnd: name(config.deviceEndColumn),
    deduplicateBy: name(config.deduplicateBy),
    aggregation: config.aggregation ?? 'median',
    rateBasis: config.rateBasis ?? 1000,
    sigmaWidth: config.sigmaWidth ?? 3,
    lambda: config.lambda ?? 0.2,
    target: config.target ?? null,
    runsRules: config.runsRules ?? 'anhoj',
    runLength: config.runLength ?? 6,
    baselineUntil: config.baselineUntil || null,
  }
}
