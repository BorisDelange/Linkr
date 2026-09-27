import { openDB, type IDBPDatabase } from 'idb'
import { CATALOG_CSS } from './export-html-style'
import { CATALOG_SCRIPT } from './export-html-script'
import type { PageLocale } from './page-text'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import type { DataCatalog, SchemaMapping } from '@/types'
import { perfLog } from './perf'

/*
 * The rendered catalog page, kept per catalog, language and view so the Publish tab
 * opens on it at once — across tab switches (memory) and app reloads
 * (IndexedDB, this browser only). A page is a function of the catalog fields
 * it prints, its computed results, the schema and the page code: the key holds
 * all four, so a new computation, an edit the page shows or a new app build
 * simply misses and renders again. Nothing to invalidate by hand.
 *
 * The key digests those fields, not `updatedAt`: any save stamps a new
 * `updatedAt` (and the server's differs from the one the store sets), which
 * threw the page away on edits it never shows.
 */

const DB_NAME = 'linkr-catalog-pages'
const STORE = 'pages'
const SCHEMAS = 'schemas'

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
export function catalogPageKey(parts: {
  catalog: DataCatalog
  computedAt: string
  schemaMapping: SchemaMapping | undefined
  fullSchema: IntrospectedTable[] | null
  locale: PageLocale
}): string {
  const { name, description, variables, crossings, counts, anonymization, dcatApMetadata, license } = parts.catalog
  const shown = { name, description, variables, crossings, counts, anonymization, dcatApMetadata, license }
  return [
    digest(JSON.stringify(shown)),
    parts.computedAt,
    digest(JSON.stringify([parts.schemaMapping ?? null, parts.fullSchema])),
    parts.locale,
    pageCodeDigest(),
  ].join('|')
}

const memory = new Map<string, CachedPage>()
const slot = (catalogId: string, variant: string) => `${catalogId}:${variant}`

let dbPromise: Promise<IDBPDatabase> | null = null
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 2, {
    upgrade: (d) => {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
      if (!d.objectStoreNames.contains(SCHEMAS)) d.createObjectStore(SCHEMAS)
    },
    blocked: () => perfLog('page store: upgrade blocked by another open tab'),
  })
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

/**
 * The database's introspected tables, which the page's Schema tab lists. Asking
 * the server takes seconds on a large warehouse, so the last answer is kept:
 * the page renders from it at once, while a fresh one is fetched for the next
 * render (whose key then differs only if the schema did).
 */
const schemas = new Map<string, IntrospectedTable[] | null>()
const inFlight = new Map<string, Promise<IntrospectedTable[] | null>>()

export async function getDatabaseSchema(dataSourceId: string, fetch: () => Promise<IntrospectedTable[] | null>): Promise<IntrospectedTable[] | null> {
  if (schemas.has(dataSourceId)) return schemas.get(dataSourceId) ?? null
  const refresh = () => {
    let p = inFlight.get(dataSourceId)
    if (!p) {
      const t = performance.now()
      p = fetch().then(async (tables) => {
        perfLog('schema: server introspection', t)
        schemas.set(dataSourceId, tables)
        inFlight.delete(dataSourceId)
        if (tables) await (await db()).put(SCHEMAS, tables, dataSourceId).catch(() => {})
        return tables
      })
      inFlight.set(dataSourceId, p)
    }
    return p
  }
  try {
    const t = performance.now()
    const stored = (await (await db()).get(SCHEMAS, dataSourceId)) as IntrospectedTable[] | undefined
    perfLog(stored ? 'schema: from browser store' : 'schema: none stored, asking the server', t)
    if (stored) {
      void refresh()
      return stored
    }
  } catch {
    // No database: ask the server.
  }
  return refresh()
}
