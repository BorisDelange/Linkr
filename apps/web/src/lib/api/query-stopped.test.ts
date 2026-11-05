import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api-client'
import { isQueryStopped } from './query-stopped'

describe('isQueryStopped', () => {
  it('reads a stop, from the panel or by the caller, as a stop', () => {
    expect(isQueryStopped(new ApiError(409, JSON.stringify({ detail: 'cancelled from the jobs panel' })))).toBe(true)
    expect(isQueryStopped(new ApiError(409, JSON.stringify({ detail: 'query cancelled' })))).toBe(true)
    expect(isQueryStopped(new ApiError(499, JSON.stringify({ detail: 'The task was cancelled' })))).toBe(true)
    expect(isQueryStopped(new DOMException('stopped', 'AbortError'))).toBe(true)
  })

  it('reads anything else as a failure', () => {
    expect(isQueryStopped(new ApiError(409, JSON.stringify({ detail: { code: 'database_etl_running' } })))).toBe(false)
    expect(isQueryStopped(new ApiError(422, JSON.stringify({ detail: 'query cancelled' })))).toBe(false)
    expect(isQueryStopped(new Error('cancelled from the jobs panel'))).toBe(false)
  })
})
