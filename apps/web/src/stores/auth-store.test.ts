import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-client', () => ({ getApiBaseUrl: () => 'http://api', isServerMode: () => true }))
vi.mock('@/lib/concept-mapping/export-masking', () => ({ setExportMinCount: vi.fn() }))
vi.mock('@/lib/password-policy', () => ({ setPasswordMinLength: vi.fn() }))
vi.mock('@/lib/terminal-sessions', () => ({ disposeAllLiveTerminals: vi.fn() }))
vi.mock('@/stores/file-store', () => ({ useFileStore: { setState: vi.fn() } }))

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage
}

function jwtFor(subject: string): string {
  return `h.${btoa(JSON.stringify({ sub: subject }))}.s`
}

const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })

describe('the end of a session', () => {
  let listeners: ((e: Partial<StorageEvent>) => void)[]
  let reload: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>

  async function load(token = jwtFor('1')) {
    vi.stubGlobal('localStorage', memoryStorage({ 'linkr-access-token': token, 'linkr-refresh-token': 'refresh' }))
    vi.resetModules()
    return (await import('./auth-store')).useAuthStore
  }

  beforeEach(() => {
    listeners = []
    reload = vi.fn()
    fetchMock = vi.fn(async () => respond(200))
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('window', {
      location: { reload },
      addEventListener: (_: string, l: (e: Partial<StorageEvent>) => void) => listeners.push(l),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('reaches the server with the session it ends, then reloads the page', async () => {
    const store = await load('access')
    store.getState().logout()
    expect(store.getState().token).toBeNull()
    expect(localStorage.getItem('linkr-access-token')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    await flush()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api/api/v1/auth/logout')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.headers.Authorization).toBe('Bearer access')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('renews an expired access token so the server still hears of the logout', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/refresh')) return respond(200, { access_token: 'renewed' })
      return (init.headers as Record<string, string>).Authorization === 'Bearer renewed' ? respond(200) : respond(401)
    })
    const store = await load('expired')
    store.getState().logout()
    await flush()
    expect(fetchMock.mock.calls.map(([url]) => url.split('/').pop())).toEqual(['logout', 'refresh', 'logout'])
    expect(reload).toHaveBeenCalledOnce()
  })

  it('still reloads when the server cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const store = await load()
    store.getState().logout()
    await flush()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads when the stored session turns out to be over', async () => {
    fetchMock.mockImplementation(async () => respond(401))
    const store = await load()
    expect(await store.getState().validateToken()).toBe(false)
    expect(store.getState().token).toBeNull()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps the front proxy from signing back in only on the load after a logout', async () => {
    const store = await load()
    store.getState().logout()
    await flush()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => respond(200, { needs_setup: false, trusted_header_login: true }))

    const called = (name: string) => fetchMock.mock.calls.some(([url]) => url.endsWith(name))
    await store.getState().checkSetupStatus()
    expect(called('/trusted-login')).toBe(false)
    await store.getState().checkSetupStatus()
    expect(called('/trusted-login')).toBe(true)
  })

  describe('in another tab', () => {
    const event = (oldValue: string | null) => ({ key: 'linkr-access-token', oldValue })

    it('reloads when the tokens are removed or now belong to someone else', async () => {
      await load(jwtFor('2'))
      listeners[0](event(jwtFor('1')))
      expect(reload).toHaveBeenCalledOnce()

      localStorage.removeItem('linkr-access-token')
      listeners[0](event(jwtFor('1')))
      expect(reload).toHaveBeenCalledTimes(2)
      expect(sessionStorage.getItem('linkr-logged-out')).toBe('1')
    })

    it('leaves the tab alone when the same user renews their token', async () => {
      await load(jwtFor('1'))
      listeners[0](event(jwtFor('1')))
      expect(reload).not.toHaveBeenCalled()
    })
  })
})
