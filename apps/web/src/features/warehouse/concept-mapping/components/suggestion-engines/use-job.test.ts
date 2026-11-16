import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api-client'
import { pollFailure } from './use-job'

describe('pollFailure', () => {
  it('retries when the server cannot be reached or fails', () => {
    expect(pollFailure(new TypeError('Failed to fetch'))).toBe('retry')
    expect(pollFailure(new ApiError(502, 'bad gateway'))).toBe('retry')
    expect(pollFailure(new ApiError(500, 'boom'))).toBe('retry')
    expect(pollFailure(new ApiError(408, 'request timeout'))).toBe('retry')
    expect(pollFailure(new ApiError(429, 'too many requests'))).toBe('retry')
    // A session expired: signed in again, the next poll answers.
    expect(pollFailure(new ApiError(401, 'unauthorized'))).toBe('retry')
  })

  it('gives up on a job the server says is gone or not ours', () => {
    expect(pollFailure(new ApiError(404, 'not found'))).toBe('gone')
    expect(pollFailure(new ApiError(403, 'forbidden'))).toBe('gone')
    expect(pollFailure(new ApiError(410, 'gone'))).toBe('gone')
  })
})
