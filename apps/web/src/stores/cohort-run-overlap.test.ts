import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Cohort, SchemaMapping } from '@/types'

/**
 * Two runs of one cohort (Cmd+Enter in the SQL editor bypasses the Stop button)
 * used to share its state: the second replaced the first's abort controller, the
 * first to finish cleared the spinner and the last to finish won.
 */

const pending: { sql: string; resolve: (rows: Record<string, unknown>[]) => void; signal?: AbortSignal }[] = []

vi.mock('@/lib/duckdb/engine', () => ({
  queryDataSource: (_id: string, sql: string, opts?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      pending.push({ sql, resolve, signal: opts?.signal })
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}))

vi.mock('@/lib/duckdb/cohort-query', () => ({
  buildCohortCountSql: (c: Cohort) => `COUNT ${c.customSql ?? 'criteria'}`,
  buildAttritionQueries: () => [],
  buildCohortResultsSql: () => null,
  buildCustomSqlOutputSql: () => null,
  buildCohortMembershipSql: () => null,
  cohortRunError: (_c: Cohort, message: string) => message,
}))

const update = vi.fn(async () => {})
vi.mock('@/lib/storage', () => ({ getStorage: () => ({ cohorts: { update } }) }))

const { useCohortStore } = await import('./cohort-store')

const COHORT = {
  id: 'c1',
  projectUid: 'p1',
  name: { en: 'c' },
  description: { en: '' },
  level: 'patient',
  criteriaTree: { kind: 'group', id: 'g', operator: 'AND', children: [], exclude: false, enabled: true },
  customSql: null,
  schemaVersion: 5,
  createdAt: '',
  updatedAt: '',
} as unknown as Cohort
const MAPPING = {} as SchemaMapping

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('overlapping cohort runs', () => {
  beforeEach(() => {
    pending.length = 0
    update.mockClear()
    useCohortStore.setState({
      cohorts: [COHORT],
      executionResults: new Map(),
      executionLoading: new Map(),
      executionErrors: new Map(),
      customSqlOutputs: new Map(),
      executionAborts: new Map(),
    })
  })

  it('a second run stops the first, whose late end writes nothing', async () => {
    const store = useCohortStore.getState()
    const first = store.executeCohort('c1', 'ds', MAPPING, 'SELECT 1 AS patient_id')
    await flush()
    const second = store.executeCohort('c1', 'ds', MAPPING, 'SELECT 2 AS patient_id')
    await flush()

    expect(pending[0].signal?.aborted).toBe(true)
    await first
    let s = useCohortStore.getState()
    expect(s.executionLoading.get('c1')).toBe(true)
    expect(s.executionErrors.has('c1')).toBe(false)
    expect(s.executionAborts.has('c1')).toBe(true)

    pending[1].resolve([{ cnt: 2 }])
    await second
    s = useCohortStore.getState()
    expect(s.executionResults.get('c1')?.totalCount).toBe(2)
    expect(s.executionResults.get('c1')?.fromDraft).toEqual({ customSql: 'SELECT 2 AS patient_id' })
    expect(s.executionLoading.get('c1')).toBe(false)
    expect(s.executionAborts.has('c1')).toBe(false)
  })

  it('Stop reaches the latest run', async () => {
    const store = useCohortStore.getState()
    void store.executeCohort('c1', 'ds', MAPPING)
    await flush()
    const second = store.executeCohort('c1', 'ds', MAPPING)
    await flush()
    useCohortStore.getState().cancelExecution('c1')
    await second
    expect(pending[1].signal?.aborted).toBe(true)
    expect(useCohortStore.getState().executionErrors.get('c1')).toBe('CANCELLED')
  })

  it('a draft result is dropped once the draft is cancelled, kept once saved', async () => {
    const store = useCohortStore.getState()
    const run = store.executeCohort('c1', 'ds', MAPPING, 'SELECT 3 AS patient_id')
    await flush()
    pending[0].resolve([{ cnt: 3 }])
    await run
    await useCohortStore.getState().settleDraftResult('c1')
    expect(useCohortStore.getState().executionResults.has('c1')).toBe(false)

    const again = store.executeCohort('c1', 'ds', MAPPING, 'SELECT 3 AS patient_id')
    await flush()
    pending[1].resolve([{ cnt: 3 }])
    await again
    useCohortStore.setState((s) => ({ cohorts: s.cohorts.map((c) => ({ ...c, customSql: 'SELECT 3 AS patient_id' })) }))
    await useCohortStore.getState().settleDraftResult('c1')
    const kept = useCohortStore.getState().executionResults.get('c1')
    expect(kept?.totalCount).toBe(3)
    expect(kept?.fromDraft).toBeUndefined()
    expect(update).toHaveBeenCalledWith('c1', { resultCount: 3, attrition: [] })
  })
})
