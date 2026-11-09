// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const sent: { path: string; init?: RequestInit }[] = []
vi.mock('@/lib/api-client', () => ({
  apiRequest: (path: string, init?: RequestInit) => {
    sent.push({ path, init })
    return path.endsWith('/query') ? new Promise(() => {}) : Promise.resolve()
  },
  apiFetch: vi.fn(),
}))

const { queryDataSourceOnServer } = await import('./data-sources')

describe('a page left', () => {
  it('stops the queries it still waits on, as it goes', async () => {
    void queryDataSourceOnServer('db', 'SELECT 1')
    await Promise.resolve()
    const { queryId } = JSON.parse(String(sent[0].init!.body))
    window.dispatchEvent(new Event('pagehide'))
    const cancel = sent.find((r) => r.path === '/data-sources/db/query/cancel')
    expect(JSON.parse(String(cancel!.init!.body))).toEqual({ queryId })
    expect(cancel!.init!.keepalive).toBe(true)
  })
})
