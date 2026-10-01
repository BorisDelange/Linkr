import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalogCache, saveCatalogCache } from './cache'
import type { CatalogCache } from './types'

/** The cache is keyed by catalog id, and an id can be repointed at another repo. */

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})

beforeEach(() => store.clear())

const cache: CatalogCache = { fetchedAt: 'now', contentHash: 'h', generatedAt: 'g', entries: [], hashes: {} }
const repoA = { url: 'https://gitlab.example.org/a/catalog', branch: 'main' }

describe('catalog cache', () => {
  it('reads back a cache downloaded from the same repo and branch', () => {
    saveCatalogCache('c1', repoA, cache)
    expect(loadCatalogCache('c1', repoA)).toMatchObject({ contentHash: 'h', source: repoA })
  })

  it('ignores a cache downloaded from another repo under the same id', () => {
    saveCatalogCache('c1', repoA, cache)
    expect(loadCatalogCache('c1', { ...repoA, url: 'https://gitlab.example.org/b/catalog' })).toBeNull()
  })

  it('ignores a cache downloaded from another branch', () => {
    saveCatalogCache('c1', repoA, cache)
    expect(loadCatalogCache('c1', { ...repoA, branch: 'dev' })).toBeNull()
  })

  it('ignores a cache that does not say where it came from', () => {
    store.set('linkr-catalog-cache:c1', JSON.stringify(cache))
    expect(loadCatalogCache('c1', repoA)).toBeNull()
  })
})
