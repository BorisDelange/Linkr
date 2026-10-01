/**
 * Persist each downloaded catalog in localStorage, one key per configured catalog.
 *
 * Deliberately not IndexedDB: the catalog is re-downloadable public data, so it doesn't
 * warrant a `DB_VERSION` bump and an `upgrade()` case in idb-storage. Key prefix follows
 * the app convention (`linkr-*`).
 */

import type { CatalogCache, CatalogCacheSource } from './types'

const cacheKey = (catalogId: string) => `linkr-catalog-cache:${catalogId}`

/**
 * The cache of `catalogId`, or null when there is none or it was downloaded from
 * another repo than `source` (a cache with no recorded source counts as another).
 */
export function loadCatalogCache(catalogId: string, source: CatalogCacheSource): CatalogCache | null {
  try {
    const raw = localStorage.getItem(cacheKey(catalogId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CatalogCache
    // A cache written by an older/newer build may not have entries; treat as absent
    // rather than rendering a broken page.
    if (!Array.isArray(parsed?.entries)) return null
    if (parsed.source?.url !== source.url || parsed.source?.branch !== source.branch) return null
    return parsed
  } catch {
    return null
  }
}

export function saveCatalogCache(catalogId: string, source: CatalogCacheSource, cache: CatalogCache): void {
  try {
    const tagged: CatalogCache = { ...cache, source: { url: source.url, branch: source.branch } }
    localStorage.setItem(cacheKey(catalogId), JSON.stringify(tagged))
  } catch {
    // Quota exceeded or storage disabled — the catalog still works for this session,
    // it just won't survive a reload.
  }
}

export function clearCatalogCache(catalogId: string): void {
  try {
    localStorage.removeItem(cacheKey(catalogId))
  } catch {
    /* nothing to do */
  }
}
