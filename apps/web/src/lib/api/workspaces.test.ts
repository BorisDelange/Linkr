import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWorkspaceExportZipFromServer } from './workspaces'

describe('fetchWorkspaceExportZipFromServer', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hands back how many projects were left out for the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('zip', { headers: { 'x-linkr-projects-left-out': '2' } })))
    const r = await fetchWorkspaceExportZipFromServer('w')
    expect(r?.leftOutProjects).toBe(2)
    expect(await r?.blob.text()).toBe('zip')
  })

  it('reads an absent or garbled count as none', async () => {
    for (const headers of [{}, { 'x-linkr-projects-left-out': 'x' }] as Record<string, string>[]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('zip', { headers })))
      expect((await fetchWorkspaceExportZipFromServer('w'))?.leftOutProjects).toBe(0)
    }
  })
})
