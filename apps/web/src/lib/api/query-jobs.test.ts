import { describe, it, expect, vi, beforeEach } from 'vitest'

// The job's successive states, one per poll; the rows of each key.
let polls: Record<string, unknown>[] = []
const requests: string[] = []
// Errors the next requests fail with, before answering again.
const failures: unknown[] = []
vi.mock('@/lib/api-client', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return {
    ApiError,
    apiRequest: async (path: string) => {
      requests.push(path)
      if (failures.length) throw failures.shift()
      if (path.includes('/results/')) return { rows: [{ key: path.split('/').pop() }] }
      return polls.length > 1 ? polls.shift() : polls[0]
    },
  }
})
vi.mock('./environments', () => ({ cancelJob: vi.fn(async () => {}) }))
vi.useFakeTimers({ toFake: ['setTimeout'] })

const { followQueryJob, isJobGone } = await import('./query-jobs')
const { ApiError } = await import('@/lib/api-client')

const job = (status: string, result: Record<string, unknown>) => ({ id: 'j', status, logTail: '', result })

async function follow(keys: string[], opts: { fetchRows?: boolean } = {}) {
  const rows: unknown[][] = []
  const waiting: [number, number | null][] = []
  const run = followQueryJob('ds', 'j', keys, async (_i, r) => { rows.push(r) }, {
    signal: new AbortController().signal,
    onWaiting: (i, reading) => waiting.push([i, reading]),
    ...opts,
  })
  // Each poll waits 1.5 s before the next; a retry up to 30 s.
  const settled = run.then(() => {}, () => {})
  for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1500)
  await settled
  return { outcome: await run, rows, waiting }
}

beforeEach(() => {
  requests.length = 0
  failures.length = 0
})

describe('followQueryJob', () => {
  it("passes on how far the query in flight has read, only for that query", async () => {
    polls = [
      job('running', { done: [], total: 2, current: 'a', reading: 40 }),
      job('running', { done: ['a'], total: 2, current: 'a', reading: 90 }),
      job('running', { done: ['a'], total: 2, current: 'b', reading: 12 }),
      job('running', { done: ['a'], total: 2 }),
      job('done', { done: ['a', 'b'], total: 2 }),
    ]
    const { outcome, rows, waiting } = await follow(['a', 'b'])
    expect(outcome).toEqual({ status: 'done', delivered: 2, error: null })
    expect(rows).toEqual([[{ key: 'a' }], [{ key: 'b' }]])
    // The stale figure of `a` is not read as `b`'s.
    expect(waiting).toEqual([[0, 40], [1, null], [1, 12], [1, null]])
  })

  it('hands each query over without fetching rows the server kept itself', async () => {
    polls = [job('done', { done: ['u1', 'assemble-0'], total: 2 })]
    const { outcome, rows } = await follow(['u1', 'assemble-0'], { fetchRows: false })
    expect(outcome.delivered).toBe(2)
    expect(rows).toEqual([[], []])
    expect(requests.some((r) => r.includes('/results/'))).toBe(false)
  })

  it('rides out a gateway error or a dropped connection on a poll or a result', async () => {
    polls = [job('running', { done: [], total: 1 }), job('done', { done: ['a'], total: 1 })]
    failures.push(new ApiError(504, 'gateway timeout'), new TypeError('Failed to fetch'), new ApiError(502, 'bad gateway'))
    const { outcome, rows } = await follow(['a'])
    expect(outcome).toEqual({ status: 'done', delivered: 1, error: null })
    expect(rows).toEqual([[{ key: 'a' }]])
  })

  it('gives up on an error that says the job is gone, and after a bounded number of retries', async () => {
    polls = [job('running', { done: [], total: 1 })]
    failures.push(new ApiError(404, 'Job not found'))
    await expect(follow(['a'])).rejects.toSatisfy(isJobGone)
    expect(requests).toHaveLength(1)

    requests.length = 0
    failures.push(...Array.from({ length: 10 }, () => new ApiError(503, 'unavailable')))
    await expect(follow(['a'])).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(7)
  })
})
