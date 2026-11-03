import { describe, expect, it } from 'vitest'
import type { CohortReportData } from '@/lib/cohort-report/model'
import type { Cohort } from '@/types'
import { reportDataKey, reportRunOf, startReportRun, stopReportRun } from './report-runs'

const data = { blocks: {}, membership: 'SELECT 1', computedAt: '' } as CohortReportData

/** A generation that ends when the test says, and records its signal. */
function pending() {
  let resolve!: (m: CohortReportData) => void
  let signal!: AbortSignal
  const build = (s: AbortSignal) => {
    signal = s
    return new Promise<CohortReportData>((res, rej) => {
      resolve = res
      s.addEventListener('abort', () => rej(new Error('aborted')))
    })
  }
  return { build, resolve: (m: CohortReportData) => resolve(m), signal: () => signal }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('report runs', () => {
  it('outlive the dialog: the run is found, then its figures, under the same key', async () => {
    const run = pending()
    startReportRun('c1', 'k', run.build)
    expect(reportRunOf('c1')).toMatchObject({ key: 'k', state: { status: 'running' } })
    run.resolve(data)
    await flush()
    expect(reportRunOf('c1')).toMatchObject({ key: 'k', state: { status: 'done', data } })
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

  it('are keyed by what the figures depend on: the database and the definition', () => {
    const cohort = { level: 'patient', criteriaTree: { kind: 'group', children: [] }, name: { en: 'A' } } as unknown as Cohort
    expect(reportDataKey('db', { ...cohort, name: { en: 'B' }, customSql: '  ' })).toBe(reportDataKey('db', cohort))
    expect(reportDataKey('db', { ...cohort, level: 'visit' })).not.toBe(reportDataKey('db', cohort))
    expect(reportDataKey('other', cohort)).not.toBe(reportDataKey('db', cohort))
  })
})
