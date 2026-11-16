import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
vi.mock('@/lib/api-client', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return { ApiError, apiRequest: (...args: unknown[]) => api(...args), isServerMode: () => true }
})
const runs = { start: vi.fn(), latest: vi.fn(), cancel: vi.fn() }
vi.mock('@/lib/api/server-runs', () => ({
  ACTIVE_RUN_STATUSES: ['queued', 'running', 'pausing'],
  startServerRun: (...a: unknown[]) => runs.start(...a),
  getLatestServerRun: (...a: unknown[]) => runs.latest(...a),
  cancelServerRun: (...a: unknown[]) => runs.cancel(...a),
}))
vi.mock('@/lib/duckdb/engine', () => ({}))

const { followServerPlan, planSignature, signedPlan } = await import('./query-plan')
const FIXTURE = (await import('@/lib/__fixtures__/server-runs/plan-signature.json')).default

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
    const old = { id: 'old', status: 'running', state: {}, signature: 'old' }
    runs.latest.mockResolvedValue(old)
    expect(await followServerPlan('cohort_run', 'c1', signed, () => {}, { resumeOnly: true })).toBeNull()

    runs.start.mockResolvedValueOnce(old).mockResolvedValueOnce({ id: 'new', status: 'done', state: {}, signature: 'new' })
    runs.latest.mockReset()
    runs.latest.mockResolvedValueOnce(old).mockResolvedValueOnce({ ...old, status: 'cancelled' })
    const followed = followServerPlan('cohort_run', 'c1', signed, () => {})
    await vi.runAllTimersAsync()
    expect((await followed)?.id).toBe('new')
    expect(runs.cancel).toHaveBeenCalledWith('old')
    expect(runs.start).toHaveBeenCalledTimes(2)
  })

  it('a re-run while the run is being stopped waits for it to end, then starts anew', async () => {
    const signed = { ...PLAN, meta: { signature: 's' } }
    const first = { id: 'first', status: 'running', requested: null, state: {}, signature: 's' }
    runs.start.mockResolvedValueOnce(first)
    runs.latest.mockResolvedValue(first)
    const controller = new AbortController()
    const followed = followServerPlan('cohort_run', 'c1', signed, () => {}, { signal: controller.signal })
    const settled = expect(followed).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10)
    let asked!: () => void
    runs.cancel.mockImplementationOnce(() => new Promise((resolve) => { asked = () => resolve({ ...first, status: 'pausing', requested: 'cancel' }) }))
    controller.abort()
    await settled

    // Same signature, yet the run being stopped is not joined.
    const stoppingRun = { ...first, status: 'pausing', requested: 'cancel' }
    runs.start.mockResolvedValueOnce(stoppingRun).mockResolvedValueOnce({ id: 'second', status: 'done', requested: null, state: {}, signature: 's' })
    runs.latest.mockReset()
    runs.latest.mockResolvedValueOnce(stoppingRun).mockResolvedValueOnce({ ...first, status: 'cancelled' })
    const again = followServerPlan('cohort_run', 'c1', signed, () => {})
    await vi.advanceTimersByTimeAsync(10)
    // The second waits for the first one's cancel to reach the server before it starts.
    expect(runs.start).toHaveBeenCalledTimes(1)
    asked()
    await vi.runAllTimersAsync()
    expect((await again)?.id).toBe('second')
    expect(runs.start).toHaveBeenCalledTimes(3)
  })

  it('rides out a gateway error or a dropped connection on a poll or a result', async () => {
    const { ApiError } = await import('@/lib/api-client')
    runs.start.mockResolvedValue(run('running', {}))
    runs.latest.mockRejectedValueOnce(new ApiError(504, 'gateway timeout')).mockResolvedValueOnce(run('done', { rows: { a: 1 } }))
    api.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const got: unknown[] = []
    const done = followServerPlan('database_stats', 'ds:stats', PLAN, (i, rows) => got.push([i, rows]))
    await vi.runAllTimersAsync()
    expect((await done)?.status).toBe('done')
    expect(got).toEqual([[0, [{ from: 'a' }]]])
  })

  it('a run replaced by one of another definition is reported ended, not as going on', async () => {
    const signed = { ...PLAN, meta: { signature: 's' } }
    runs.start.mockResolvedValue({ id: 'mine', status: 'running', state: {}, signature: 's' })
    runs.latest.mockResolvedValue({ id: 'theirs', status: 'running', state: {}, signature: 'other' })
    const followed = followServerPlan('cohort_run', 'c1', signed, () => {})
    await vi.runAllTimersAsync()
    expect(await followed).toMatchObject({ id: 'mine', status: 'cancelled' })
  })

  it('a run started after the stop was asked is cancelled at once', async () => {
    let started!: (r: unknown) => void
    runs.start.mockImplementation(() => new Promise((resolve) => { started = resolve }))
    const controller = new AbortController()
    const followed = followServerPlan('database_stats', 'ds:x', PLAN, () => {}, { signal: controller.signal })
    const settled = expect(followed).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    started({ id: 'late', status: 'running', state: {} })
    await settled
    expect(runs.cancel).toHaveBeenCalledWith('late')
  })

  it('joins only the run the server signed as its plan, whatever the run says of itself', async () => {
    const signed = { ...PLAN, meta: { signature: 's' } }
    runs.latest.mockResolvedValue({ id: 'claimed', status: 'running', state: { meta: { signature: 's' } }, signature: 'other' })
    expect(await followServerPlan('cohort_run', 'c1', signed, () => {}, { resumeOnly: true })).toBeNull()
  })

  it('signs a plan by its database, its queries and their keys: the same tables in another order sign differently', async () => {
    const sign = async (tables: string[], ds = 'ds') =>
      (await signedPlan(ds, { label: 'L', items: tables.map((t, i) => ({ key: `t${i}`, sql: `SELECT COUNT(*) FROM ${t}` })) })).meta?.signature
    expect(await sign(['a', 'b'])).toBe(await sign(['a', 'b']))
    expect(await sign(['a', 'b'])).not.toBe(await sign(['b', 'a']))
    expect(await sign(['a', 'b'])).not.toBe(await sign(['a', 'b'], 'other'))
  })
})

describe('a plan signature', () => {
  it('is the one the server computes for the same plan (shared fixture)', async () => {
    expect(await planSignature(FIXTURE.dataSourceId, FIXTURE.plan)).toBe(FIXTURE.signature)
  })

  it('is the same outside a secure context, where Web Crypto is missing', async () => {
    vi.stubGlobal('crypto', {})
    try {
      expect(await planSignature(FIXTURE.dataSourceId, FIXTURE.plan)).toBe(FIXTURE.signature)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('covers the signature basis', async () => {
    const other = { ...FIXTURE.plan, meta: { ...FIXTURE.plan.meta, signatureBasis: ['visit'] } }
    expect(await planSignature(FIXTURE.dataSourceId, other)).not.toBe(FIXTURE.signature)
  })
})
