/**
 * Which catalog repos the app knows, and which one the Catalog page shows.
 *
 * Kept out of app-store preferences: this is catalog-scoped config read by the catalog
 * module alone, and it lives next to the cache it invalidates. Per browser, like the
 * cache itself.
 */

import type { LocalizedString } from '@/types'
import { clearCatalogCache } from './cache'
import {
  DEFAULT_CATALOG_BRANCH,
  DEFAULT_CATALOG_URL,
  parseCatalogUrl,
  type CatalogSource,
} from './remote'

/** A catalog repo the user has added, with the name the switcher shows. */
export interface CatalogConfig {
  id: string
  name: LocalizedString
  url: string
  branch: string
}

export interface CatalogSettings {
  catalogs: CatalogConfig[]
  /** Id of the catalog the Catalog page shows; '' when the list is empty. */
  activeId: string
}

export const DEFAULT_CATALOG_ID = 'community'

/**
 * The community catalog. Also what the setup wizard reads the default data from,
 * whatever the user's list holds — it can be deleted from the list like any other.
 */
export const DEFAULT_CATALOG: CatalogConfig = {
  id: DEFAULT_CATALOG_ID,
  name: { en: 'Community catalog', fr: 'Catalogue communautaire' },
  url: DEFAULT_CATALOG_URL,
  branch: DEFAULT_CATALOG_BRANCH,
}

const SETTINGS_KEY = 'linkr-catalogs'
/** The single-catalog setting this list replaced, read once to carry a custom repo over. */
const LEGACY_SETTINGS_KEY = 'linkr-catalog-source'

function defaults(): CatalogSettings {
  return { catalogs: [DEFAULT_CATALOG], activeId: DEFAULT_CATALOG_ID }
}

function isCatalogConfig(value: unknown): value is CatalogConfig {
  const c = value as Partial<CatalogConfig> | null
  return !!c && typeof c.id === 'string' && typeof c.url === 'string' && typeof c.branch === 'string'
    && typeof c.name === 'object' && c.name !== null
}

/** A custom repo configured under the single-catalog setting becomes a second entry. */
function fromLegacy(): CatalogSettings | null {
  const raw = localStorage.getItem(LEGACY_SETTINGS_KEY)
  if (!raw) return null
  localStorage.removeItem(LEGACY_SETTINGS_KEY)
  const { url, branch } = JSON.parse(raw) as { url?: string; branch?: string }
  const source = url ? parseCatalogUrl(url, branch) : null
  if (!source || source.repoUrl === parseCatalogUrl(DEFAULT_CATALOG_URL)!.repoUrl) return null
  const custom: CatalogConfig = {
    id: crypto.randomUUID(),
    name: { en: source.project, fr: source.project },
    url: source.repoUrl,
    branch: source.branch,
  }
  return { catalogs: [DEFAULT_CATALOG, custom], activeId: custom.id }
}

export function loadCatalogSettings(): CatalogSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) {
      // The single catalog's cache, now keyed per catalog: re-downloaded on demand.
      localStorage.removeItem('linkr-catalog-cache')
      const migrated = fromLegacy()
      if (migrated) saveCatalogSettings(migrated)
      return migrated ?? defaults()
    }
    const parsed = JSON.parse(raw) as Partial<CatalogSettings>
    const catalogs = Array.isArray(parsed.catalogs) ? parsed.catalogs.filter(isCatalogConfig) : [DEFAULT_CATALOG]
    const activeId = catalogs.some((c) => c.id === parsed.activeId) ? parsed.activeId! : (catalogs[0]?.id ?? '')
    return { catalogs, activeId }
  } catch {
    return defaults()
  }
}

export function saveCatalogSettings(settings: CatalogSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* storage disabled — the list applies for this session only */
  }
}

/**
 * Replace the list, dropping the cache of every catalog that was removed or now
 * points at another repo — entries from the previous repo must not linger and be
 * diffed against the new one.
 */
export function updateCatalogs(previous: CatalogSettings, next: CatalogSettings): CatalogSettings {
  for (const old of previous.catalogs) {
    const now = next.catalogs.find((c) => c.id === old.id)
    if (!now || now.url !== old.url || now.branch !== old.branch) clearCatalogCache(old.id)
  }
  const activeId = next.catalogs.some((c) => c.id === next.activeId) ? next.activeId : (next.catalogs[0]?.id ?? '')
  const settings = { catalogs: next.catalogs, activeId }
  saveCatalogSettings(settings)
  return settings
}

/** Resolved source to fetch from, or null when the URL is unusable. */
export function catalogSourceOf(catalog: CatalogConfig): CatalogSource | null {
  return parseCatalogUrl(catalog.url, catalog.branch)
}

// ---------------------------------------------------------------------------
// Install target
// ---------------------------------------------------------------------------

const TARGET_KEY = 'linkr-catalog-target-workspace'

/**
 * The workspace the catalog installs into, remembered across visits — leaving the
 * page and coming back used to reset the picker, so a second install silently
 * targeted a different workspace than the first.
 *
 * Deliberately NOT the app's `activeWorkspaceId`: switching that closes the open
 * project (see `openWorkspace`), which browsing a catalog must never do.
 */
export function loadCatalogTargetWorkspace(): string {
  try {
    return localStorage.getItem(TARGET_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveCatalogTargetWorkspace(id: string): void {
  try {
    if (id) localStorage.setItem(TARGET_KEY, id)
    else localStorage.removeItem(TARGET_KEY)
  } catch {
    /* storage disabled — the pick applies for this session only */
  }
}
