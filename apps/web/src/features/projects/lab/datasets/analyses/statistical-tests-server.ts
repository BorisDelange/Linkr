import type { DatasetColumn } from '@/types'

export interface StatisticalTestsSpec {
  group: string | null
  values: { name: string; type: string }[]
  preference: 'auto' | 'parametric' | 'nonparametric'
  alpha: number
}

/**
 * Build the statistical-test render SPEC (group + value columns + preference +
 * alpha) sent to POST /execute/render. The server owns the pandas/scipy program
 * that turns this into the same TestResult[] JSON the client computes from rows —
 * so a viewer can render it without the server running any client-supplied code.
 * Server parity: apps/api/app/services/execution/render/statistical_tests.py (_STAT_PY).
 */
export function buildStatisticalTestsSpec(
  columns: DatasetColumn[],
  groupColumnId: string | undefined,
  valueColumnIds: string[],
  testPreference: 'auto' | 'parametric' | 'nonparametric',
  alpha: number,
): StatisticalTestsSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const groupCol = groupColumnId ? byId.get(groupColumnId) : undefined
  const values = valueColumnIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c && c.id !== groupColumnId)
    .map((c) => ({ name: c.name, type: c.type }))

  return {
    group: groupCol ? groupCol.name : null,
    values,
    preference: testPreference,
    alpha,
  }
}
