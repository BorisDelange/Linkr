/**
 * Loads the community catalog: cache-first, explicit refresh, update detection.
 *
 * Nothing is fetched on mount when the catalog has never been loaded — the user clicks
 * "Load catalog" first, so a fresh install makes no external request until asked. Once a
 * cache exists, only the ~2 KB index is polled to see whether a refresh is worth offering.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadCatalogCache, saveCatalogCache } from '@/lib/catalog/cache'
import { getCatalogSource } from '@/lib/catalog/settings'
import {
  CatalogError,
  diffCatalog,
  fetchCatalog,
  fetchCatalogIndex,
  toCache,
  type CatalogFetchError,
} from '@/lib/catalog/remote'
import type { CatalogCache, CatalogDiff, CatalogEntry } from '@/lib/catalog/types'

interface UseCatalogResult {
  entries: CatalogEntry[]
  /** True once a cache exists (or a load succeeded) — drives the empty state. */
  loaded: boolean
  loading: boolean
  /** Classified failure of the last load/refresh, or null. */
  error: CatalogFetchError | null
  /** When the full catalog was last downloaded (ISO), or null. */
  fetchedAt: string | null
  /** Date of the last change in the catalog repo itself (ISO), or null. */
  generatedAt: string | null
  /** Pending remote changes, or null when up to date / not yet checked. */
  update: CatalogDiff | null
  load: () => Promise<void>
  refresh: () => Promise<void>
}

export function useCatalog(): UseCatalogResult {
  const [cache, setCache] = useState<CatalogCache | null>(() => loadCatalogCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<CatalogFetchError | null>(null)
  const [update, setUpdate] = useState<CatalogDiff | null>(null)
  const checkedRef = useRef(false)

  const download = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const source = getCatalogSource()
      // Fetch both: the index supplies the per-entry hashes that make the *next*
      // update check able to say what changed.
      const catalog = await fetchCatalog(source)
      const index = await fetchCatalogIndex(source).catch(() => null)
      const next = toCache(catalog, index, new Date().toISOString())
      saveCatalogCache(next)
      setCache(next)
      setUpdate(null)
    } catch (err) {
      setError(err instanceof CatalogError ? err.kind : 'network')
    } finally {
      setLoading(false)
    }
  }, [])

  // Once a cache exists, check for updates once per mount (cheap: ~2 KB).
  useEffect(() => {
    if (!cache || checkedRef.current) return
    checkedRef.current = true
    let cancelled = false
    void (async () => {
      try {
        const index = await fetchCatalogIndex(getCatalogSource())
        if (cancelled) return
        if (index.contentHash === cache.contentHash) {
          setUpdate(null)
          return
        }
        const diff = diffCatalog(cache, index)
        setUpdate(diff.changed ? diff : null)
      } catch {
        // A failed background check must stay silent: the cached catalog is still
        // perfectly usable, and the user didn't ask for anything.
      }
    })()
    return () => { cancelled = true }
  }, [cache])

  return {
    entries: cache?.entries ?? [],
    loaded: !!cache,
    loading,
    error,
    fetchedAt: cache?.fetchedAt ?? null,
    generatedAt: cache?.generatedAt ?? null,
    update,
    load: download,
    refresh: download,
  }
}
