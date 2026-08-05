/**
 * Which catalog repo the app reads.
 *
 * Kept out of app-store preferences: this is catalog-scoped config read by the catalog
 * module alone, and it lives next to the cache it invalidates.
 */

import { clearCatalogCache } from './cache'
import {
  DEFAULT_CATALOG_BRANCH,
  DEFAULT_CATALOG_SOURCE,
  DEFAULT_CATALOG_URL,
  parseCatalogUrl,
  type CatalogSource,
} from './remote'

const SETTINGS_KEY = 'linkr-catalog-source'

interface StoredCatalogSettings {
  url: string
  branch: string
}

export function loadCatalogSettings(): StoredCatalogSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { url: DEFAULT_CATALOG_URL, branch: DEFAULT_CATALOG_BRANCH }
    const parsed = JSON.parse(raw) as Partial<StoredCatalogSettings>
    return {
      url: parsed.url?.trim() || DEFAULT_CATALOG_URL,
      branch: parsed.branch?.trim() || DEFAULT_CATALOG_BRANCH,
    }
  } catch {
    return { url: DEFAULT_CATALOG_URL, branch: DEFAULT_CATALOG_BRANCH }
  }
}

/** Resolved source to fetch from; falls back to the default when the stored URL is unusable. */
export function getCatalogSource(): CatalogSource {
  const { url, branch } = loadCatalogSettings()
  return parseCatalogUrl(url, branch) ?? DEFAULT_CATALOG_SOURCE
}

/**
 * Persist a new catalog repo. Clears the cache whenever the source actually changes —
 * entries from the previous catalog must not linger and be diffed against the new one.
 */
export function saveCatalogSettings(url: string, branch: string): void {
  const previous = getCatalogSource()
  const next = parseCatalogUrl(url, branch)
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ url: url.trim() || DEFAULT_CATALOG_URL, branch: branch.trim() || DEFAULT_CATALOG_BRANCH }),
    )
  } catch {
    /* storage disabled — the value applies for this session only */
  }
  if (!next || next.repoUrl !== previous.repoUrl || next.branch !== previous.branch) {
    clearCatalogCache()
  }
}

export function resetCatalogSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY)
  } catch {
    /* nothing to do */
  }
  clearCatalogCache()
}

export function isDefaultCatalog(): boolean {
  return getCatalogSource().repoUrl === DEFAULT_CATALOG_SOURCE.repoUrl
}
