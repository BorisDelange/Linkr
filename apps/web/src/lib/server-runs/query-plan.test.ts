import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
vi.mock('@/lib/api-client', () => ({ apiRequest: (...args: unknown[]) => api(...args), isServerMode: () => true }))
const runs = { start: vi.fn(), latest: vi.fn(), cancel: vi.fn() }
vi.mock('@/lib/api/server-runs', () => ({
  ACTIVE_RUN_STATUSES: ['queued', 'running', 'pausing'],
  startServerRun: (...a: unknown[]) => runs.start(...a),
  getLatestServerRun: (...a: unknown[]) => runs.latest(...a),
  cancelServerRun: (...a: unknown[]) => runs.cancel(...a),
}))
vi.mock('@/lib/duckdb/engine', () => ({}))

const { followServerPlan } = await import('./query-plan')

const PLAN = { label: 'L', items: [{ key: 'a', sql: 'A' }, { key: 'b', sql: 'B' }, { key: 'c', sql: 'C' }], keepGoing: true }
const run = (status: string, state: Record<string, unknown>) => ({ id: 'r', status, state })

beforeEach(() => {
  vi.useFakeTimers()
  api.mockReset()
  for (const f of Object.values(runs)) f.mockReset()
  runs.cancel.mockResolvedValue(run('cancelled', {}))
  api.mockImplementation(async (url: string) => ({ rows: [{ from: url.split('/').pop() }] }))
})

describe('a plan followed on the server', () => {
  it('hands each query its rows once, as they land, and its errors', async () => {
    runs.start.mockResolvedValue(run('running', { rows: { a: 1 } }))
    runs.latest.mockResolvedValueOnce(run('running', { rows: { a: 1 }, errors: { b: 'boom' } }))
    runs.latest.mockResolvedValueOnce(run('done', { rows: { a: 1, c: 1 }, errors: { b: 'boom' } }))
    const got: unknown[] = []
    const done = followServerPlan('database_stats', 'ds:stats', PLAN, (i, rows, error) => got.push([i, rows, error]))
    await vi.runAllTimersAsync()
    expect((await done)?.status).toBe('done')
    expect(got).toEqual([[0, [{ from: 'a' }], undefined], [1, null, 'boom'], [2, [{ from: 'c' }], undefined]])
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('after a reload only joins the run going on', async () => {
    runs.latest.mockResolvedValue(run('done', {}))
    expect(await followServerPlan('database_stats', 'ds:stats', PLAN, () => {}, { resumeOnly: true })).toBeNull()
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('cancels the run when stopped from here', async () => {
    runs.start.mockResolvedValue(run('running', {}))
    runs.latest.mockResolvedValue(run('running', {}))
    const controller = new AbortController()
    const followed = followServerPlan('database_stats', 'ds:stats', PLAN, () => {}, { signal: controller.signal })
    const settled = expect(followed).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.runAllTimersAsync()
    await settled
    expect(runs.cancel).toHaveBeenCalledWith('r')
  })

  it('joins only a run of its own signature: another one is replaced, or not joined', async () => {
    const signed = { ...PLAN, meta: { signature: 'new' } }
    const old = { id: 'old', status: 'running', state: { meta: { signature: 'old' } } }
    runs.latest.mockResolvedValue(old)
    expect(await followServerPlan('cohort_run', 'c1', signed, () => {}, { resumeOnly: true })).toBeNull()

    runs.start.mockResolvedValueOnce(old).mockResolvedValueOnce({ id: 'new', status: 'done', state: { meta: { signature: 'new' } } })
    runs.latest.mockReset()
    runs.latest.mockResolvedValueOnce(old).mockResolvedValueOnce({ ...old, status: 'cancelled' })
    const followed = followServerPlan('cohort_run', 'c1', signed, () => {})
    await vi.runAllTimersAsync()
    expect((await followed)?.id).toBe('new')
    expect(runs.cancel).toHaveBeenCalledWith('old')
    expect(runs.start).toHaveBeenCalledTimes(2)
  })
})
