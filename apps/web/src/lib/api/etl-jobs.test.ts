import { describe, it, expect, vi, beforeEach } from 'vitest'

let polls: Record<string, unknown>[] = []
const posted: unknown[] = []
vi.mock('@/lib/api-client', () => ({
  apiRequest: async (_path: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body))
    return { id: 'j' }
  },
}))
vi.mock('./query-jobs', () => ({
  getJob: async () => (polls.length > 1 ? polls.shift() : polls[0]),
  queryJobRows: async () => [{ n: 1 }],
}))
const cancelJob = vi.fn(async () => {})
vi.mock('./environments', () => ({ cancelJob: () => cancelJob() }))
vi.useFakeTimers({ toFake: ['setTimeout'] })

const { runEtlJob, EtlJobCancelledError } = await import('./etl-jobs')

const job = (status: string, result: Record<string, unknown> | null) => ({ id: 'j', status, logTail: '', result })

/** Run the polls out; `p` is settled, its outcome checked by the caller. */
async function settle<T>(p: Promise<T>) {
  p.catch(() => {})
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1000)
  return p
}

beforeEach(() => {
  posted.length = 0
  cancelJob.mockClear()
})

describe('runEtlJob', () => {
  it('sends the script whole, reports each statement once, then hands the last rows over', async () => {
    polls = [
      job('queued', null),
      job('running', { index: 0, total: 2, sql: 'A', reading: 30 }),
      job('running', { index: 0, total: 2, sql: 'A', reading: 80 }),
      job('running', { index: 1, total: 2, sql: 'B' }),
      job('done', { index: 1, total: 2, sql: 'B', done: ['rows'] }),
    ]
    const statements: [number, number, string][] = []
    const readings: (number | null)[] = []
    const rows = await settle(runEtlJob('t', 'ETL', 'A; B;', { source: 's' }, {}, {
      onStatement: (i, n, sql) => statements.push([i, n, sql]),
      onReading: (pct) => readings.push(pct),
    }))
    expect(posted[0]).toEqual({ label: 'ETL', sql: 'A; B;', roles: { source: 's' }, mappingData: {} })
    expect(statements).toEqual([[0, 2, 'A'], [1, 2, 'B']])
    expect(readings).toContain(80)
    expect(rows).toEqual([{ n: 1 }])
  })

  it('fails with the error the job kept', async () => {
    polls = [job('error', { index: 0, total: 1, sql: 'A', error: 'Catalog Error: no table x' })]
    await expect(settle(runEtlJob('t', 'ETL', 'A;', {}))).rejects.toThrow('no table x')
  })

  it('reads a cancel from the jobs panel as a stop, and a stop here cancels the job', async () => {
    polls = [job('cancelled', null)]
    await expect(settle(runEtlJob('t', 'ETL', 'A;', {}))).rejects.toBeInstanceOf(EtlJobCancelledError)

    polls = [job('running', { index: 0, total: 1, sql: 'A' })]
    const ctrl = new AbortController()
    const run = runEtlJob('t', 'ETL', 'A;', {}, {}, { signal: ctrl.signal })
    const settled = expect(run).rejects.toBeInstanceOf(EtlJobCancelledError)
    await vi.advanceTimersByTimeAsync(10)
    ctrl.abort()
    await settled
    expect(cancelJob).toHaveBeenCalled()
  })
})
