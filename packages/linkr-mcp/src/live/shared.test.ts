import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './shared'

describe('api proxy', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('keeps the login token on the client across calls made through the proxy', async () => {
    vi.stubEnv('LINKR_API_URL', 'http://linkr.test')
    vi.stubEnv('LINKR_USERNAME', 'u')
    vi.stubEnv('LINKR_PASSWORD', 'p')
    const auth: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/login')) return Response.json({ access_token: 'tok', refresh_token: 'r' })
      auth.push(String((init.headers as Record<string, string>).Authorization))
      return Response.json([])
    }))
    await api.request('GET', '/workspaces')
    await api.request('GET', '/projects')
    expect(auth).toEqual(['Bearer tok', 'Bearer tok'])
  })
})
