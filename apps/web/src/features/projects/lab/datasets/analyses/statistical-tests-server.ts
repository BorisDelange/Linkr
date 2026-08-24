import type { DatasetColumn } from '@/types'
import { overrideApplies, type TestName } from '@/lib/stats/applicable-tests'

export interface StatisticalTestsSpec {
  group: string | null
  values: { name: string; type: string }[]
  preference: 'auto' | 'parametric' | 'nonparametric'
  alpha: number
  /**
   * Per-variable pinned tests, keyed by column NAME.
   *
   * Config stores them by column ID; the spec speaks names, like every other
   * field here. Translated in the builder rather than at the call site so the
   * two cannot drift.
   */
  overrides?: Record<string, TestName>
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
  /** Pinned tests keyed by column ID, as stored in the config. */
  testOverrides: Record<string, TestName> = {},
  /** Distinct group values, so an override that no longer fits is dropped. */
  groupCount = 0,
): StatisticalTestsSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const groupCol = groupColumnId ? byId.get(groupColumnId) : undefined
  const picked = valueColumnIds
    .map((id) => byId.get(id))
    .filter((c): c is DatasetColumn => !!c && c.id !== groupColumnId)
  const values = picked.map((c) => ({ name: c.name, type: c.type }))

  const overrides: Record<string, TestName> = {}
  for (const c of picked) {
    const pinned = testOverrides[c.id]
    const kind = c.type === 'number' ? 'numeric' : 'categorical'
    if (overrideApplies(pinned, kind, groupCount)) overrides[c.name] = pinned!
  }

  return {
    group: groupCol ? groupCol.name : null,
    values,
    preference: testPreference,
    alpha,
    // Omitted when empty so the cache key (and the golden specs) do not change
    // for an analysis that pins nothing.
    ...(Object.keys(overrides).length > 0 ? { overrides } : null),
  }
}
