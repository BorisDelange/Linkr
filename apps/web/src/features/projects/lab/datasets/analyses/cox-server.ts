import type { DatasetColumn } from '@/types'

/** One term of the fitted model, on both the log-hazard and hazard-ratio scales. */
export interface CoxCoefficient {
  name: string
  /** The log-hazard coefficient — the linear scale the forest plot works on. */
  coef: number | null
  hazardRatio: number | null
  se: number | null
  z: number | null
  pValue: number | null
  ciLow: number | null
  ciHigh: number | null
}

/** Schoenfeld-residual test of the proportional-hazards assumption, per term. */
export interface ProportionalHazardsRow {
  name: string
  statistic: number | null
  pValue: number | null
}

export interface CoxResult {
  coefficients: CoxCoefficient[]
  nObs: number
  nEvents: number
  concordance: number | null
  logLikelihood: number | null
  aic: number | null
  confidenceLevel: number
  logLikelihoodRatioTest?: { statistic: number | null; pValue: number | null; df: number }
  proportionalHazards?: ProportionalHazardsRow[]
  warnings: string[]
  /** Set instead of a fit when the model could not be produced at all. */
  error?: string
}

export interface CoxSpec {
  time: string
  event: string
  predictors: { name: string; numeric: boolean }[]
  confidenceLevel: number
}

/**
 * Build the Cox render SPEC sent to POST /execute/render.
 *
 * Unlike the other analyses this has no in-browser counterpart: fitting a Cox
 * model needs lifelines, so the plugin offers the tab only in server mode.
 * Server program: apps/api/app/services/execution/render/cox.py.
 */
export function buildCoxSpec(
  columns: DatasetColumn[],
  timeId: string,
  eventId: string,
  predictorIds: string[],
  confidenceLevel: number,
): CoxSpec | null {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const time = byId.get(timeId)
  const event = byId.get(eventId)
  if (!time || !event) return null

  const predictors = predictorIds
    // The time and event columns describe the outcome; as predictors they would
    // be collinear with it by construction. The server drops them too, but
    // filtering here keeps the spec — and so the cache key — honest.
    .filter((id) => id !== timeId && id !== eventId)
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c)
    .map((c) => ({ name: c.name, numeric: c.type === 'number' }))

  if (predictors.length === 0) return null

  return { time: time.name, event: event.name, predictors, confidenceLevel }
}
