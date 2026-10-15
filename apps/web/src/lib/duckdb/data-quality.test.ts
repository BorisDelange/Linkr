import { describe, it, expect, vi } from 'vitest'

vi.mock('./engine', () => ({ queryDataSource: vi.fn() }))
const { checkPushdown, checkResult } = await import('./data-quality')
import type { DqCheck } from './data-quality-checks'

const check = { id: 'c1', sql: 'SELECT 1', threshold: 5, origin: 'schema' } as unknown as DqCheck

describe('checkResult', () => {
  it('judges the share of violated rows against the threshold', () => {
    expect(checkResult(check, [{ violated_rows: 10, total_rows: 100 }], 12.4)).toMatchObject({
      checkId: 'c1', status: 'fail', violatedRows: 10, totalRows: 100, pctViolated: 10, executionTimeMs: 12,
    })
    expect(checkResult(check, [{ violated_rows: 1, total_rows: 100 }], 0).status).toBe('pass')
  })

  it('is not applicable without rows, and an error keeps its message', () => {
    expect(checkResult(check, [], 3).status).toBe('not_applicable')
    expect(checkResult(check, [], 3, 'table missing')).toMatchObject({ status: 'error', errorMessage: 'table missing' })
  })
})

describe('checkPushdown', () => {
  it('never sends a hand-written check to the external database', () => {
    expect(checkPushdown(check)).toBe(true)
    expect(checkPushdown({ ...check, origin: 'manual' })).toBe(false)
  })
})
