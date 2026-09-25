import { describe, expect, it, vi } from 'vitest'
import { createIdentify, isSharedKey, keyTag, presentedKey, toolCallLogLines } from './auth'

const SHARED = 's'.repeat(32)
const API = 'http://linkr.test'

function okFetch(ok = true) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: ok ? 200 : 401 }))
}

describe('presentedKey', () => {
  it('reads X-API-Key first, then a Bearer header in any casing', () => {
    expect(presentedKey(new Headers({ 'x-api-key': 'a', authorization: 'Bearer b' }))).toBe('a')
    expect(presentedKey(new Headers({ authorization: 'bEaReR   lnk_x' }))).toBe('lnk_x')
    expect(presentedKey(new Headers())).toBe('')
  })
})

describe('isSharedKey', () => {
  it('fails closed when no shared key is configured', () => {
    expect(isSharedKey('', undefined)).toBe(false)
    expect(isSharedKey('', '')).toBe(false)
  })

  it('refuses a key of a different length without throwing', () => {
    expect(isSharedKey(SHARED.slice(1), SHARED)).toBe(false)
    expect(isSharedKey(`${SHARED}x`, SHARED)).toBe(false)
    expect(isSharedKey(SHARED, SHARED)).toBe(true)
  })
})

describe('createIdentify', () => {
  it('refuses a shared key shorter than 24 characters', () => {
    expect(() => createIdentify({ apiUrl: API, sharedKey: 'short' })).toThrow(/24 characters/)
  })

  it('routes lnk_ keys to Linkr and caches an accepted one', async () => {
    const fetch = okFetch()
    const identify = createIdentify({ apiUrl: API, sharedKey: SHARED, fetch })
    const headers = new Headers({ authorization: 'Bearer lnk_abc' })
    expect(await identify(headers)).toEqual({ token: 'lnk_abc' })
    expect(await identify(headers)).toEqual({ token: 'lnk_abc' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`${API}/api/v1/auth/me`)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer lnk_abc')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses an lnk_ key Linkr rejects, even if it equals the shared key', async () => {
    const lnkShared = `lnk_${SHARED}`
    const identify = createIdentify({ apiUrl: API, sharedKey: lnkShared, fetch: okFetch(false) })
    expect(await identify(new Headers({ 'x-api-key': lnkShared }))).toBeNull()
  })

  it('serves the shared key with the .env credentials, never asking Linkr', async () => {
    const fetch = okFetch()
    const identify = createIdentify({ apiUrl: API, sharedKey: SHARED, fetch })
    expect(await identify(new Headers({ authorization: `bearer ${SHARED}` }))).toBe('env')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed without a shared key', async () => {
    const identify = createIdentify({ apiUrl: API, fetch: okFetch() })
    expect(await identify(new Headers())).toBeNull()
    expect(await identify(new Headers({ authorization: 'Bearer ' }))).toBeNull()
    expect(await identify(new Headers({ 'x-api-key': SHARED }))).toBeNull()
  })

  it('rejects when Linkr does not answer in time, and caches nothing', async () => {
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))
    const identify = createIdentify({ apiUrl: API, fetch: hanging, timeoutMs: 20 })
    const headers = new Headers({ 'x-api-key': 'lnk_slow' })
    await expect(identify(headers)).rejects.toThrow()
    await expect(identify(headers)).rejects.toThrow()
    expect(hanging).toHaveBeenCalledTimes(2)
  })
})

describe('keyTag', () => {
  it('is a short stable hash that differs between keys', () => {
    expect(keyTag('lnk_a')).toMatch(/^[0-9a-f]{8}$/)
    expect(keyTag('lnk_a')).toBe(keyTag('lnk_a'))
    expect(keyTag('lnk_a')).not.toBe(keyTag('lnk_b'))
    expect(keyTag('lnk_secret')).not.toContain('secret')
  })
})

describe('toolCallLogLines', () => {
  const call = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const time = new Date(2026, 0, 1, 12, 0, 0)

  it('logs the tool name and caller tag only, by default', () => {
    const body = JSON.stringify(call('run_sql', { sql: 'SELECT * FROM person WHERE person_id = 42' }))
    const [line] = toolCallLogLines(body, 'abcd1234', false, time)
    expect(line).toBe(`${time.toLocaleTimeString()} [abcd1234] run_sql`)
    expect(line).not.toContain('42')
  })

  it('adds truncated arguments when opted in', () => {
    const body = JSON.stringify(call('run_code', { code: 'x'.repeat(500) }))
    const [line] = toolCallLogLines(body, 't', true, time)
    expect(line).toContain('run_code {"code":"xxx')
    expect(line.endsWith('…')).toBe(true)
  })

  it('handles batches, skips other methods and ignores non-JSON', () => {
    const body = JSON.stringify([call('a', {}), { jsonrpc: '2.0', method: 'tools/list' }, null, call('b', {})])
    expect(toolCallLogLines(body, 't', false, time).map((l) => l.split(' ').at(-1))).toEqual(['a', 'b'])
    expect(toolCallLogLines('not json', 't', false)).toEqual([])
  })
})
