/**
 * Persist the downloaded catalog in localStorage.
 *
 * Deliberately not IndexedDB: the catalog is re-downloadable public data, so it doesn't
 * warrant a `DB_VERSION` bump and an `upgrade()` case in idb-storage. Key prefix follows
 * the app convention (`linkr-*`).
 */

import type { CatalogCache } from './types'

const CACHE_KEY = 'linkr-catalog-cache'

export function loadCatalogCache(): CatalogCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
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

export function saveCatalogCache(cache: CatalogCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Quota exceeded or storage disabled — the catalog still works for this session,
    // it just won't survive a reload.
  }
}

export function clearCatalogCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* nothing to do */
  }
}
