/**
 * The entry point: a config plus rows in, a chart out.
 *
 * This module owns the two decisions that make an SPC chart right or wrong
 * before any arithmetic happens — which variance model applies, and which chart
 * type suits the data — and it owns them EXPLICITLY.
 *
 * That is a deliberate reaction to how the hand-written scripts behaved. They
 * branched on "is this column numeric?" first and only consulted the configured
 * denominator if it was not, so a widget could set `denominator =
 * "patient_days_overlap"` on a numeric column and silently get an x-bar chart of
 * the median instead of the rate its title promised. Eighteen of the twenty EWMA
 * widgets in the NeoCLIP dashboard are in exactly that state.
 *
 * So auto-detection here proposes and reports; it never contradicts an explicit
 * setting in silence. When a configured option cannot apply, the result carries
 * an `option-ignored` warning rather than quietly doing something else.
 */

import { aggregate, eventIntervals, toNumber } from './spc-aggregate'
import {
  buildCChart,
  buildEwmaChart,
  buildGChart,
  buildIChart,
  buildNpChart,
  buildPChart,
  buildTChart,
  buildUChart,
} from './spc-limits'
import { applyRules } from './spc-rules'
import type {
  ChartType,
  DenominatorMode,
  Period,
  PeriodPoint,
  RunsRuleSet,
  SpcResult,
  SpcWarning,
  StatisticType,
} from './spc-types'

export interface SpcConfig {
  statisticType: StatisticType | 'auto'
  chartType: ChartType | 'auto'
  dateColumn: string
  valueColumn: string
  period: Period
  eventValues?: string[]
  denominatorMode: DenominatorMode
  exposureColumn?: string
  admissionColumn?: string
  dischargeColumn?: string
  deviceStartColumn?: string
  deviceEndColumn?: string
  deduplicateBy?: string
  aggregation?: 'mean' | 'median' | 'sum' | 'min' | 'max'
  rateBasis?: number
  sigmaWidth?: number
  lambda?: number
  target?: number
  runsRules?: RunsRuleSet
  runLength?: number
  /** Freeze the limits on periods up to this ISO date. Absent = fit on all data. */
  baselineUntil?: string
}

/** Below this many events, a rate or proportion chart is mostly noise. */
const RARE_EVENT_THRESHOLD = 5

/** A chart needs some history before its limits mean anything. */
const MIN_PERIODS = 8

/**
 * Detect what kind of statistic a column carries.
 *
 * A column is a measurement when its values parse as numbers AND take more than
 * a handful of distinct values. The second condition matters: a 0/1 event flag
 * parses as numeric but is a proportion, not a measurement — charting its
 * monthly mean as an x-bar chart is exactly the confusion this guards against.
 */
export function detectStatisticType(
  rows: Record<string, unknown>[],
  valueColumn: string,
  denominatorMode: DenominatorMode,
): StatisticType {
  const sample = rows.slice(0, 2000)
  const values = sample.map(r => r[valueColumn]).filter(v => v != null && v !== '')
  if (values.length === 0) return 'proportion'

  const distinct = new Set(values.map(v => String(v)))
  const numeric = values.filter(v => toNumber(v) !== null).length
  const mostlyNumeric = numeric / values.length > 0.8

  if (mostlyNumeric && distinct.size > 3) return 'measurement'
  return denominatorMode === 'cases' ? 'proportion' : 'rate'
}

/** Pick a chart type from the statistic and what the data actually look like. */
export function suggestChartType(statisticType: StatisticType, points: PeriodPoint[]): ChartType {
  const totalEvents = points.reduce((a, p) => a + p.y, 0)
  switch (statisticType) {
    case 'measurement':
      return 'i-mr'
    case 'rare-event':
      return 'g'
    case 'rate':
      return totalEvents < RARE_EVENT_THRESHOLD * points.length ? 'u' : 'u-prime'
    case 'proportion': {
      // Overdispersion bites when denominators are large; the prime chart is the
      // safe default there and collapses to the plain one when it is not needed.
      const meanN = points.length ? points.reduce((a, p) => a + p.n, 0) / points.length : 0
      return meanN > 300 ? 'p-prime' : 'p'
    }
  }
}

/** Index of the first period after the baseline. */
function resolveBaseline(points: PeriodPoint[], baselineUntil?: string): number {
  if (!baselineUntil) return points.length
  const end = points.findIndex(p => p.date > baselineUntil)
  if (end === -1) return points.length
  return end
}

/** Variance of the plotted statistic for one period, per the model. */
function varianceFor(
  statisticType: StatisticType,
  centre: number,
  basis: number,
): (p: PeriodPoint) => number {
  if (statisticType === 'proportion') return p => (p.n > 0 ? (centre * (1 - centre)) / p.n : 0)
  if (statisticType === 'rate') return p => (p.n > 0 ? (centre * basis) / p.n : 0)
  return p => {
    if (p.variance !== undefined && p.n > 0) return p.variance / p.n
    return 0
  }
}

export function computeSpc(rows: Record<string, unknown>[], config: SpcConfig): SpcResult | null {
  if (!config.dateColumn || !config.valueColumn) return null

  const warnings: SpcWarning[] = []
  const statisticType =
    config.statisticType === 'auto'
      ? detectStatisticType(rows, config.valueColumn, config.denominatorMode)
      : config.statisticType

  // A measurement has no event denominator, so a configured denominator mode
  // cannot apply. Say so rather than ignoring it silently — this is the exact
  // failure the hand-written scripts shipped.
  if (statisticType === 'measurement' && config.denominatorMode !== 'cases') {
    warnings.push({ code: 'option-ignored', detail: config.denominatorMode })
  }

  const basis = config.rateBasis ?? 1000
  const sigmaWidth = config.sigmaWidth ?? 3

  const points =
    statisticType === 'rare-event'
      ? eventIntervals(rows, config.dateColumn, config.valueColumn, config.eventValues, config.deduplicateBy)
      : aggregate({
          rows,
          statisticType,
          dateColumn: config.dateColumn,
          period: config.period,
          valueColumn: config.valueColumn,
          eventValues: config.eventValues,
          denominatorMode: config.denominatorMode,
          exposureColumn: config.exposureColumn,
          admissionColumn: config.admissionColumn,
          dischargeColumn: config.dischargeColumn,
          deviceStartColumn: config.deviceStartColumn,
          deviceEndColumn: config.deviceEndColumn,
          deduplicateBy: config.deduplicateBy,
          aggregation: config.aggregation,
        })

  if (points.length === 0) return null
  if (points.length < MIN_PERIODS) {
    warnings.push({ code: 'too-few-periods', detail: String(points.length) })
  }

  const chartType = config.chartType === 'auto' ? suggestChartType(statisticType, points) : config.chartType

  let baselineEnd = resolveBaseline(points, config.baselineUntil)
  if (baselineEnd < 2) {
    warnings.push({ code: 'baseline-too-short', detail: String(baselineEnd) })
    baselineEnd = points.length
  }
  const baseline = { end: baselineEnd }
  const common = { points, baseline, sigmaWidth, target: config.target }

  // A rate charted on a handful of events is noise plotted with authority; the
  // interval between events carries the same information without the artefact.
  if (statisticType !== 'rare-event' && (chartType === 'u' || chartType === 'u-prime' || chartType === 'p')) {
    const totalEvents = points.reduce((a, p) => a + p.y, 0)
    if (totalEvents < RARE_EVENT_THRESHOLD * points.length) {
      warnings.push({ code: 'rare-events-prefer-g', detail: String(totalEvents) })
    }
  }

  let result: SpcResult
  switch (chartType) {
    case 'p':
    case 'p-prime':
      result = buildPChart({ ...common, prime: chartType === 'p-prime' })
      break
    case 'u':
    case 'u-prime':
      result = buildUChart({ ...common, basis, prime: chartType === 'u-prime' })
      result.yUnit = `/${basis}`
      break
    case 'c':
      result = buildCChart(common)
      break
    case 'np':
      result = buildNpChart(common)
      break
    case 'i-mr':
      result = buildIChart(common)
      break
    case 'g':
      result = buildGChart(common)
      break
    case 't':
      result = buildTChart(common)
      break
    case 'ewma': {
      // The EWMA's centre and variance follow the underlying statistic, so it
      // needs the same model the equivalent Shewhart chart would use.
      const valueOf =
        statisticType === 'measurement'
          ? (p: PeriodPoint) => p.y
          : statisticType === 'rate'
            ? (p: PeriodPoint) => (p.n > 0 ? (p.y / p.n) * basis : 0)
            : (p: PeriodPoint) => (p.n > 0 ? p.y / p.n : 0)
      const baseValues = points.slice(0, baseline.end).map(valueOf)
      const centre =
        config.target ?? (baseValues.length ? baseValues.reduce((a, b) => a + b, 0) / baseValues.length : 0)
      const bounds =
        statisticType === 'proportion' ? { min: 0, max: 1 } : statisticType === 'rate' ? { min: 0 } : {}
      result = buildEwmaChart({
        ...common,
        lambda: config.lambda ?? 0.2,
        valueOf,
        varianceOf: varianceFor(statisticType, centre, basis),
        bounds,
      })
      if (statisticType === 'rate') result.yUnit = `/${basis}`
      break
    }
  }

  applyRules(result.points, {
    ruleSet: config.runsRules ?? 'anhoj',
    runLength: config.runLength,
  })

  result.warnings = [...warnings, ...result.warnings]
  return result
}
