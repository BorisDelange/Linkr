import type { DatasetColumn } from '@/types'

export interface RegressionSpec {
  outcome: { name: string; numeric: boolean } | null
  predictors: { name: string; numeric: boolean }[]
  regressionType: 'auto' | 'linear' | 'logistic'
  confidenceLevel: number
}

/**
 * Build the regression render SPEC (outcome + predictors → name+numeric, type,
 * confidence) sent to POST /execute/render. The server owns the statsmodels program
 * that fits the model and prints the same RegressionResult JSON the client computes
 * from rows — so a viewer can render it without the server running any client-supplied
 * code. Server parity: apps/api/app/services/execution/render/regression.py (_REG_PY).
 */
export function buildRegressionSpec(
  columns: DatasetColumn[],
  outcomeId: string,
  predictorIds: string[],
  regressionType: 'auto' | 'linear' | 'logistic',
  confidenceLevel: number,
): RegressionSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const outcome = byId.get(outcomeId)
  const predictors = predictorIds
    .filter((id) => id !== outcomeId)
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c)
    .map((c) => ({ name: c.name, numeric: c.type === 'number' }))

  return {
    outcome: outcome ? { name: outcome.name, numeric: outcome.type === 'number' } : null,
    predictors,
    regressionType,
    confidenceLevel,
  }
}
