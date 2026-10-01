/**
 * Persist each downloaded catalog in localStorage, one key per configured catalog.
 *
 * Deliberately not IndexedDB: the catalog is re-downloadable public data, so it doesn't
 * warrant a `DB_VERSION` bump and an `upgrade()` case in idb-storage. Key prefix follows
 * the app convention (`linkr-*`).
 */

import type { CatalogCache } from './types'

const cacheKey = (catalogId: string) => `linkr-catalog-cache:${catalogId}`

export function loadCatalogCache(catalogId: string): CatalogCache | null {
  try {
    const raw = localStorage.getItem(cacheKey(catalogId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CatalogCache
    // A cache written by an older/newer build may not have entries; treat as absent
    // rather than rendering a broken page.
    if (!Array.isArray(parsed?.entries)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveCatalogCache(catalogId: string, cache: CatalogCache): void {
  try {
    localStorage.setItem(cacheKey(catalogId), JSON.stringify(cache))
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
