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
const cancelJob = vi.fn(async (_id: string) => {})
const GONE = Object.assign(new Error('Job not found'), { gone: true })
vi.mock('@/lib/api/query-jobs', () => ({
  startQueryJob: (...a: unknown[]) => (startQueryJob as (...x: unknown[]) => unknown)(...a),
  followQueryJob: (...a: unknown[]) => followQueryJob(...a),
  isJobGone: (err: unknown) => (err as { gone?: boolean }).gone === true,
  isTransient: (err: unknown) => err instanceof TypeError || [502, 503, 504].includes((err as { status?: number }).status ?? 0),
}))
vi.mock('@/lib/api/environments', () => ({ cancelJob: (id: string) => cancelJob(id) }))
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
  cancelJob.mockClear()
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

  it('cancels a job started for other queries rather than follow it, and a resume with nothing to follow starts nothing', async () => {
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'other' }))
    expect(await run({ resumeOnly: true })).toBeNull()
    expect(startQueryJob).not.toHaveBeenCalled()
    expect(cancelJob).toHaveBeenCalledWith('old')
    expect(hasRememberedJob('n')).toBe(false)
  })

  it('starts over when the remembered job is gone', async () => {
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'sig' }))
    followQueryJob.mockRejectedValueOnce(GONE).mockResolvedValueOnce(done)
    expect(await run()).toEqual(done)
    expect(startQueryJob).toHaveBeenCalledOnce()
    expect(cancelJob).not.toHaveBeenCalled()
    // Resuming only, a gone job ends the resume quietly, and is forgotten.
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'sig' }))
    followQueryJob.mockRejectedValueOnce(GONE)
    expect(await run({ resumeOnly: true })).toBeNull()
    expect(hasRememberedJob('n')).toBe(false)
  })

  it('keeps the job remembered when following it fails while it may still run', async () => {
    followQueryJob.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(run()).rejects.toThrow('Failed to fetch')
    expect(readStored()).toEqual({ jobId: 'new', signature: 'sig' })
    // A resume that cannot reach it either leaves it for the next one.
    followQueryJob.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await run({ resumeOnly: true })).toBeNull()
    expect(readStored()?.jobId).toBe('new')
  })

  it('forgets the job when following it fails for a reason other than the way to it', async () => {
    followQueryJob.mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 500 }))
    await expect(run()).rejects.toThrow('Server error')
    expect(hasRememberedJob('n')).toBe(false)
    followQueryJob.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
    await expect(run()).rejects.toThrow('Unauthorized')
    expect(hasRememberedJob('n')).toBe(false)
    followQueryJob.mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502 }))
    await expect(run()).rejects.toThrow('Bad gateway')
    expect(hasRememberedJob('n')).toBe(true)
  })

  it("forgets the job when the caller's own handler throws, even a TypeError", async () => {
    followQueryJob.mockImplementation(async (_ds: string, _id: string, _keys: string[], cb: (...a: unknown[]) => Promise<void>) => {
      await cb(0, [], done)
      return done
    })
    const onResult = () => { throw new TypeError('handler bug') }
    await expect(runQueryJob('ds', 'Label', queries, onResult, { signal: new AbortController().signal, remember }))
      .rejects.toThrow('handler bug')
    expect(hasRememberedJob('n')).toBe(false)
  })

  it('cancels a remembered job it could not follow before starting another', async () => {
    store.set('linkr:query-job:n', JSON.stringify({ jobId: 'old', signature: 'sig' }))
    followQueryJob.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(done)
    expect(await run()).toEqual(done)
    expect(cancelJob).toHaveBeenCalledWith('old')
    expect(startQueryJob).toHaveBeenCalledOnce()
    expect(hasRememberedJob('n')).toBe(false)
  })

  it('forgets the job once aborted (the follower cancels it)', async () => {
    const controller = new AbortController()
    followQueryJob.mockImplementationOnce(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(run({ signal: controller.signal })).rejects.toThrow('aborted')
    expect(hasRememberedJob('n')).toBe(false)
  })
})

function readStored(): { jobId: string; signature: string } | null {
  const raw = store.get('linkr:query-job:n')
  return raw ? JSON.parse(raw) : null
}
