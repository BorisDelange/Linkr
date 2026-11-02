import { describe, expect, it } from 'vitest'
import type { CohortReportModel } from '@/lib/cohort-report/model'
import { reportRunOf, startReportRun, stopReportRun } from './report-runs'

const model = { title: 'r' } as CohortReportModel

/** A generation that ends when the test says, and records its signal. */
function pending() {
  let resolve!: (m: CohortReportModel) => void
  let signal!: AbortSignal
  const build = (s: AbortSignal) => {
    signal = s
    return new Promise<CohortReportModel>((res, rej) => {
      resolve = res
      s.addEventListener('abort', () => rej(new Error('aborted')))
    })
  }
  return { build, resolve: (m: CohortReportModel) => resolve(m), signal: () => signal }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('report runs', () => {
  it('outlive the dialog: the run is found, then its report, under the same key', async () => {
    const run = pending()
    startReportRun('c1', 'k', run.build)
    expect(reportRunOf('c1')).toMatchObject({ key: 'k', state: { status: 'running' } })
    run.resolve(model)
    await flush()
    expect(reportRunOf('c1')).toMatchObject({ key: 'k', state: { status: 'done', model } })
  })

  it('Stop cancels the queries and says so', async () => {
    const run = pending()
    startReportRun('c2', 'k', run.build)
    stopReportRun('c2')
    expect(run.signal().aborted).toBe(true)
    await flush()
    expect(reportRunOf('c2')?.state).toEqual({ status: 'stopped' })
  })

  it('a new run of the cohort stops the previous one, whose end writes nothing', async () => {
    const first = pending()
    const second = pending()
    startReportRun('c3', 'a', first.build)
    startReportRun('c3', 'b', second.build)
    expect(first.signal().aborted).toBe(true)
    await flush()
    expect(reportRunOf('c3')).toMatchObject({ key: 'b', state: { status: 'running' } })
  })
})
