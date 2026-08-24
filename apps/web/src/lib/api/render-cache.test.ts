/**
 * The render cache behind `renderOnServer`.
 *
 * What matters here is not that caching happens but that it can never serve a
 * result for a different question: any change of spec, dataset, filters or
 * project must miss. The transport is stubbed so these assertions are about
 * the key, not about the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiRequest = vi.fn()

vi.mock('@/lib/api-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  isServerMode: () => true,
}))
vi.mock('@/stores/app-store', () => ({
  useAppStore: { getState: () => ({ activeProjectUid: 'proj-1' }) },
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ getActiveSessionId: () => 'default' }) },
}))

const { renderOnServer, clearRenderCache } = await import('./execution')

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue({ stdout: '{"ok":true}', stderr: '' })
  clearRenderCache()
})

const opts = { datasetFileId: 'ds-1' }

describe('renderOnServer caching', () => {
  it('serves an identical request from cache', async () => {
    await renderOnServer('regression', { a: 1 }, opts)
    await renderOnServer('regression', { a: 1 }, opts)
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('re-runs when the spec changes', async () => {
    await renderOnServer('regression', { a: 1 }, opts)
    await renderOnServer('regression', { a: 2 }, opts)
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('re-runs when the dataset or the filters change', async () => {
    await renderOnServer('regression', { a: 1 }, opts)
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-2' })
    await renderOnServer('regression', { a: 1 }, { ...opts, datasetFilters: [{ col: 'x' }] })
    expect(apiRequest).toHaveBeenCalledTimes(3)
  })

  it('does not confuse two kinds sharing a spec', async () => {
    await renderOnServer('regression', { a: 1 }, opts)
    await renderOnServer('correlation-matrix', { a: 1 }, opts)
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('re-runs when forced — the data may have changed underneath', async () => {
    await renderOnServer('regression', { a: 1 }, opts)
    await renderOnServer('regression', { a: 1 }, { ...opts, force: true })
    expect(apiRequest).toHaveBeenCalledTimes(2)
    // ...and the refreshed result is what a later plain call gets.
    await renderOnServer('regression', { a: 1 }, opts)
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('never caches a failed run', async () => {
    apiRequest.mockResolvedValueOnce({ stdout: '', stderr: 'boom' })
    await renderOnServer('regression', { a: 1 }, opts)
    const second = await renderOnServer('regression', { a: 1 }, opts)
    expect(apiRequest).toHaveBeenCalledTimes(2)
    expect(second.stderr).toBe('')
  })

  it('clears one dataset without disturbing another', async () => {
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-1' })
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-2' })
    expect(apiRequest).toHaveBeenCalledTimes(2)

    clearRenderCache('ds-1')
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-2' })
    expect(apiRequest).toHaveBeenCalledTimes(2) // ds-2 still cached
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-1' })
    expect(apiRequest).toHaveBeenCalledTimes(3) // ds-1 re-ran
  })

  it('clears a dataset id that is a prefix of another', async () => {
    // `ds-1` must not evict `ds-10`: the key delimits fields for this reason.
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-1' })
    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-10' })
    clearRenderCache('ds-1')

    await renderOnServer('regression', { a: 1 }, { datasetFileId: 'ds-10' })
    expect(apiRequest).toHaveBeenCalledTimes(2) // ds-10 survived
  })
})
