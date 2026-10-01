/**
 * Loads the community catalog: cache-first, explicit refresh, update detection.
 *
 * Nothing is fetched on mount when the catalog has never been loaded — the user clicks
 * "Load catalog" first, so a fresh install makes no external request until asked. Once a
 * cache exists, only the ~2 KB index is polled to see whether a refresh is worth offering.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadCatalogCache, saveCatalogCache } from '@/lib/catalog/cache'
import { catalogSourceOf, type CatalogConfig } from '@/lib/catalog/settings'
import {
  CatalogError,
  diffCatalog,
  fetchCatalog,
  fetchCatalogIndex,
  toCache,
  type CatalogFetchError,
} from '@/lib/catalog/remote'
import type { CatalogCache, CatalogDiff, CatalogEntry } from '@/lib/catalog/types'

/** Stable identity for "no entries" — see the note on `entries` below. */
const EMPTY_ENTRIES: CatalogEntry[] = []

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

/**
 * `catalog` is the repo to read; null (no catalog configured) reads as never loaded.
 * Switching it swaps to that catalog's own cache.
 */
export function useCatalog(catalog: CatalogConfig | null): UseCatalogResult {
  const [cache, setCache] = useState<CatalogCache | null>(() => (catalog ? loadCatalogCache(catalog.id, catalog) : null))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<CatalogFetchError | null>(null)
  const [update, setUpdate] = useState<CatalogDiff | null>(null)
  /** Which catalog the update check already ran for — once per catalog per mount. */
  const checkedRef = useRef('')
  /** The catalog on screen now, so a download that outlives a switch lands nowhere. */
  const shownRef = useRef('')

  // Swapped during render rather than in an effect, so the previous catalog's
  // entries never paint under the new one's name. Keyed on the URL too: an id can
  // be repointed at another repo, whose cache then reads as absent.
  const cacheKey = catalog ? `${catalog.id}|${catalog.url}|${catalog.branch}` : ''
  const [cacheFor, setCacheFor] = useState(cacheKey)
  if (cacheFor !== cacheKey) {
    setCacheFor(cacheKey)
    setCache(catalog ? loadCatalogCache(catalog.id, catalog) : null)
    setLoading(false)
    setError(null)
    setUpdate(null)
  }
  useEffect(() => { shownRef.current = cacheKey }, [cacheKey])

  const download = useCallback(async () => {
    if (!catalog) return
    // Every state write below is for THIS catalog: a switch mid-download must not
    // paint its spinner, error or result on the next one.
    const key = cacheKey
    const source = catalogSourceOf(catalog)
    if (!source) {
      setError('not-found')
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Fetch both: the index supplies the per-entry hashes that make the *next*
      // update check able to say what changed.
      const fetched = await fetchCatalog(source)
      const index = await fetchCatalogIndex(source).catch(() => null)
      const next = toCache(fetched, index, new Date().toISOString())
      if (shownRef.current !== key) return
      saveCatalogCache(catalog.id, catalog, next)
      setCache(next)
      setUpdate(null)
    } catch (err) {
      if (shownRef.current === key) setError(err instanceof CatalogError ? err.kind : 'network')
    } finally {
      if (shownRef.current === key) setLoading(false)
    }
  }, [catalog, cacheKey])

  // Once a cache exists, check for updates once per mount (cheap: ~2 KB).
  useEffect(() => {
    const source = catalog ? catalogSourceOf(catalog) : null
    if (!cache || !source || checkedRef.current === cacheKey) return
    checkedRef.current = cacheKey
    let cancelled = false
    void (async () => {
      try {
        const index = await fetchCatalogIndex(source)
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
  }, [cache, catalog, cacheKey])

  return {
    // NOT `?? []`: a fresh literal each render is a new reference, and callers use
    // `entries` as an effect dependency. With no cache (the catalog never loaded)
    // that spun forever — render → new [] → effect → setState → render. One frozen
    // empty array keeps the identity stable across renders.
    entries: cache?.entries ?? EMPTY_ENTRIES,
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
