import { openDB, type IDBPDatabase } from 'idb'
import { CATALOG_CSS } from './export-html-style'
import { CATALOG_SCRIPT } from './export-html-script'
import type { PageLocale } from './page-text'

/*
 * The rendered catalog page, kept per catalog, language and view so the Publish tab
 * opens on it at once — across tab switches (memory) and app reloads
 * (IndexedDB, this browser only). A page is a function of the catalog's
 * configuration, its computed results, the schema and the page code: the key
 * holds all four, so a new computation, an edit or a new app build simply
 * misses and renders again. Nothing to invalidate by hand.
 */

const DB_NAME = 'linkr-catalog-pages'
const STORE = 'pages'

interface CachedPage {
  key: string
  html: string
}

/** A short, stable digest (FNV-1a) — to tell versions apart, not for security. */
function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

let codeDigest: string | null = null
const pageCodeDigest = () => (codeDigest ??= digest(CATALOG_SCRIPT + CATALOG_CSS))

/** What the page depends on, as one string. */
export function catalogPageKey(parts: { catalogUpdatedAt: string; computedAt: string; schema: unknown; locale: PageLocale }): string {
  return [parts.catalogUpdatedAt, parts.computedAt, digest(JSON.stringify(parts.schema ?? null)), parts.locale, pageCodeDigest()].join('|')
}

const memory = new Map<string, CachedPage>()
const slot = (catalogId: string, variant: string) => `${catalogId}:${variant}`

let dbPromise: Promise<IDBPDatabase> | null = null
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, { upgrade: (d) => { d.createObjectStore(STORE) } })
  return dbPromise
}

/** `variant` tells apart the pages of one catalog: its language, and whether masked values show. */
export async function getCachedPage(catalogId: string, variant: string, key: string): Promise<string | null> {
  const id = slot(catalogId, variant)
  const hit = memory.get(id)
  if (hit?.key === key) return hit.html
  try {
    const stored = (await (await db()).get(STORE, id)) as CachedPage | undefined
    if (stored?.key !== key) return null
    memory.set(id, stored)
    return stored.html
  } catch {
    // Private browsing or a blocked database: render every time.
    return null
  }
}

/** One page per catalog and language: a newer version replaces the older one. */
export async function putCachedPage(catalogId: string, variant: string, key: string, html: string): Promise<void> {
  const id = slot(catalogId, variant)
  memory.set(id, { key, html })
  try {
    await (await db()).put(STORE, { key, html } satisfies CachedPage, id)
  } catch {
    // Kept in memory for the session all the same.
  }
}
