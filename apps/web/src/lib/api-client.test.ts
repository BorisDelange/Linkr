import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, formatApiError } from './api-client'
import i18n from './i18n'

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

describe('apiRequest proxy errors', () => {
  beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }))
  afterEach(() => vi.unstubAllGlobals())

  const nginxPage = (status: number) => new Response(
    `<html><head><title>${status}</title></head><body><center><h1>${status}</h1></center><hr><center>nginx/1.20.1</center></body></html>`,
    { status, headers: { 'content-type': 'text/html' } },
  )
  const failure = async (res: Response): Promise<ApiError> => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))
    try {
      await apiRequest('/x')
    } catch (e) {
      return e as ApiError
    }
    throw new Error('expected the request to fail')
  }

  it('words a gateway timeout instead of showing its HTML page', async () => {
    const err = await failure(nginxPage(504))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(504)
    expect(err.message).toBe(i18n.t('common.proxy_timeout'))
    expect(formatApiError(err).summary).toBe(err.message)
  })

  it('words an unreachable server and any other proxy page', async () => {
    expect((await failure(nginxPage(502))).message).toBe(i18n.t('common.proxy_unreachable', { status: 502 }))
    expect((await failure(nginxPage(413))).message).toBe(i18n.t('common.proxy_error_page', { status: 413 }))
  })

  it("keeps Linkr's own JSON errors, gateway statuses included", async () => {
    const body = JSON.stringify({ detail: 'Connection failed' })
    const err = await failure(new Response(body, { status: 502, headers: { 'content-type': 'application/json' } }))
    expect(err.message).toBe(body)
  })
})
