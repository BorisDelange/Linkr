import { describe, it, expect, vi, beforeEach } from 'vitest'

const startQueryJob = vi.fn(async () => ({ id: 'second' }))
const followQueryJob = vi.fn()
const cancelJob = vi.fn(async (_id: string) => {})
const GONE = Object.assign(new Error('Job not found'), { gone: true })
vi.mock('@/lib/api/query-jobs', () => ({
  startQueryJob: (...a: unknown[]) => (startQueryJob as (...x: unknown[]) => unknown)(...a),
  followQueryJob: (...a: unknown[]) => followQueryJob(...a),
  isJobGone: (err: unknown) => (err as { gone?: boolean }).gone === true,
}))
vi.mock('@/lib/api/environments', () => ({ cancelJob: (id: string) => cancelJob(id) }))
vi.mock('./engine', () => ({ prepareQuerySql: async (_ds: string, sql: string) => sql }))

const { jobExecutor } = await import('./catalog-job-executor')

// Hands the one query over, as a job that finished would.
const finishes = async (_ds: string, _job: string, _keys: string[], onRows: (i: number, rows: unknown[]) => Promise<void>) => {
  await onRows(0, [])
  return { status: 'done', delivered: 1, error: null }
}
const phase = (resumeJob: string | null) => ({
  name: 'base' as const,
  queries: [{ offset: 0, sql: 'SELECT 1' }],
  resumeJob,
  jobStarted: async () => {},
  starting: () => {},
  onRows: async () => {},
  signal: new AbortController().signal,
})

beforeEach(() => {
  startQueryJob.mockClear()
  followQueryJob.mockReset()
  cancelJob.mockClear()
})

describe('jobExecutor', () => {
  it('cancels the paused job it could not follow before starting the rest as a second one', async () => {
    followQueryJob.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementationOnce(finishes)
    await jobExecutor('ds', () => 'Catalog')(phase('first'))
    expect(cancelJob).toHaveBeenCalledWith('first')
    expect(cancelJob.mock.invocationCallOrder[0]).toBeLessThan(startQueryJob.mock.invocationCallOrder[0])
  })

  it('starts the rest at once when the paused job is gone', async () => {
    followQueryJob.mockRejectedValueOnce(GONE).mockImplementationOnce(finishes)
    await jobExecutor('ds', () => 'Catalog')(phase('first'))
    expect(cancelJob).not.toHaveBeenCalled()
    expect(startQueryJob).toHaveBeenCalledOnce()
  })
})
