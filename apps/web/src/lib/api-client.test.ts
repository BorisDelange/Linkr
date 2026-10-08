import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from './api-client'

describe('apiRequest deferred polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const pending = () => new Response(JSON.stringify({ deferredTaskId: 't1' }), { status: 202 })

  it('polls until the task answers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = apiRequest<{ ok: number }>('/x')
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops polling once the caller aborts', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => pending())
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const result = apiRequest('/x', { signal: controller.signal })
    const settled = expect(result).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(1600)
    const calls = fetchMock.mock.calls.length
    controller.abort()
    await settled
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock.mock.calls.length).toBe(calls)
    for (const [, init] of fetchMock.mock.calls.slice(1)) expect((init as RequestInit).signal).toBe(controller.signal)
  })
})
