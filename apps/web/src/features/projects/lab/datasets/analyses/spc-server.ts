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
  deviceFilterColumn: string | null
  deviceFilterValues: string[] | null
  exposureEntity: string | null
  aggregation: string
  rateBasis: number
  sigmaWidth: number
  lambda: number
  target: number | null
  runsRules: string
  runLength: number
  baselineUntil: string | null
}

/** `config` already carries column names (SpcComponent resolves the stored ids):
 *  resolving them a second time against the ids would null every column. */
export function buildSpcSpec(config: SpcConfig): SpcSpec {
  const name = (column: string | undefined) => column || null

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
    deviceFilterColumn: name(config.deviceFilterColumn),
    deviceFilterValues: config.deviceFilterValues && config.deviceFilterValues.length > 0 ? config.deviceFilterValues : null,
    exposureEntity: name(config.exposureEntity),
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
