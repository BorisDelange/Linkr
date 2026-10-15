import { describe, it, expect, vi, beforeEach } from 'vitest'

// Node has no localStorage: a plain map stands in for it.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const startQueryJob = vi.fn(async () => ({ id: 'new' }))
const followQueryJob = vi.fn()
vi.mock('@/lib/api/query-jobs', () => ({
  startQueryJob: (...a: unknown[]) => (startQueryJob as (...x: unknown[]) => unknown)(...a),
  followQueryJob: (...a: unknown[]) => followQueryJob(...a),
}))
vi.mock('./engine', () => ({ prepareQuerySql: async (_ds: string, sql: string) => sql }))

const { runQueryJob, hasRememberedJob } = await import('./run-query-job')

const queries = [{ key: 'q0', sql: 'SELECT 1' }]
const done = { status: 'done', delivered: 1, error: null }
const remember = { name: 'n', signature: 'sig' }
const run = (opts: Record<string, unknown> = {}) =>
  runQueryJob('ds', 'Label', queries, () => {}, { signal: new AbortController().signal, remember, ...opts })

beforeEach(() => {
  store.clear()
  startQueryJob.mockClear()
  followQueryJob.mockReset()
})

describe('runQueryJob', () => {
  it('remembers the job while it runs, and forgets it once it ended', async () => {
    followQueryJob.mockImplementation(async () => {
      expect(hasRememberedJob('n')).toBe(true)
      return done
    })
    expect(await run()).toEqual(done)
    expect(followQueryJob.mock.calls[0][1]).toBe('new')
    expect(hasRememberedJob('n')).toBe(false)
  })

  it('follows the remembered job of the same queries instead of starting one', async () => {
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'sig' }))
    followQueryJob.mockResolvedValue(done)
    await run({ resumeOnly: true })
    expect(startQueryJob).not.toHaveBeenCalled()
    expect(followQueryJob.mock.calls[0][1]).toBe('old')
  })

  it('does not follow a job started for other queries, and a resume with nothing to follow starts nothing', async () => {
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'other' }))
    expect(await run({ resumeOnly: true })).toBeNull()
    expect(startQueryJob).not.toHaveBeenCalled()
    expect(hasRememberedJob('n')).toBe(false)
  })

  it('starts over when the remembered job is gone', async () => {
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'sig' }))
    followQueryJob.mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(done)
    expect(await run()).toEqual(done)
    expect(startQueryJob).toHaveBeenCalledOnce()
    // Resuming only, a gone job ends the resume quietly.
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'sig' }))
    followQueryJob.mockRejectedValueOnce(new Error('404'))
    expect(await run({ resumeOnly: true })).toBeNull()
  })
})
