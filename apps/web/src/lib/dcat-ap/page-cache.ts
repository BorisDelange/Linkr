import { openDB, type IDBPDatabase } from 'idb'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { buildCatalogPageData, type CatalogPageData } from './export-html'
import type { PageLocale } from './page-text'

/*
 * What the Publish preview reuses between renders.
 *
 * The page's data (published crossings, concept list), per catalog, language
 * and view, in memory: a tab switch or a language round trip hands the page
 * the same object again. Its key digests the catalog fields the data reads, not
 * `updatedAt` — any save stamps a new `updatedAt`, which threw the data away on
 * edits it never shows. A reload rebuilds it from the results.
 *
 * The database's introspected tables, in IndexedDB (see `getDatabaseSchema`).
 */

const DB_NAME = 'linkr-catalog-pages'
const SCHEMAS = 'schemas'
/** Held whole rendered pages until the preview stopped inlining its data. */
const OBSOLETE_PAGES = 'pages'

/** A short, stable digest (FNV-1a) — to tell versions apart, not for security. */
function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function pageDataKey(catalog: DataCatalog, cache: CatalogResultCache): string {
  const { variables, crossings, counts, anonymization } = catalog
  return `${digest(JSON.stringify({ variables, crossings, counts, anonymization }))}|${cache.computedAt}`
}

const pageData = new Map<string, { key: string; data: CatalogPageData }>()

/** The page's data, built once per catalog, language and view until what it reads changes. */
export function getCatalogPageData(catalog: DataCatalog, cache: CatalogResultCache, locale: PageLocale, reveal: boolean): CatalogPageData {
  const slot = `${catalog.id}:${locale}:${reveal ? 'reveal' : 'masked'}`
  const key = pageDataKey(catalog, cache)
  const hit = pageData.get(slot)
  if (hit?.key === key) return hit.data
  const data = buildCatalogPageData({ catalog, cache, locale, reveal })
  pageData.set(slot, { key, data })
  return data
}

let dbPromise: Promise<IDBPDatabase> | null = null
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 3, {
    upgrade: (d) => {
      if (d.objectStoreNames.contains(OBSOLETE_PAGES)) d.deleteObjectStore(OBSOLETE_PAGES)
      if (!d.objectStoreNames.contains(SCHEMAS)) d.createObjectStore(SCHEMAS)
    },
  })
  return dbPromise
}

/**
 * The database's introspected tables, which the page's Schema tab lists. Asking
 * the server can take seconds on a large warehouse, so the last answer is kept:
 * the preview renders from it at once, while a fresh one is fetched for the next
 * render.
 *
 * `version` names the database's current schema (a digest of its mapping): a
 * kept answer for another version is not used. `fresh` waits for a new answer —
 * for a published file, which must not carry a schema from before a change the
 * mapping does not see (a table added to the database) — and falls back to the
 * kept one only when the server cannot answer.
 */
interface KeptSchema { version: string; tables: IntrospectedTable[] | null }
const schemas = new Map<string, KeptSchema>()
const inFlight = new Map<string, Promise<IntrospectedTable[] | null>>()

export function schemaVersion(mapping: unknown): string {
  return digest(JSON.stringify(mapping ?? null))
}

export async function getDatabaseSchema(
  dataSourceId: string,
  fetch: () => Promise<IntrospectedTable[] | null>,
  { version = '', fresh = false }: { version?: string; fresh?: boolean } = {},
): Promise<IntrospectedTable[] | null> {
  const kept = schemas.get(dataSourceId)
  const refresh = () => {
    const key = `${dataSourceId}|${version}`
    let p = inFlight.get(key)
    if (!p) {
      p = fetch().then(async (tables) => {
        inFlight.delete(key)
        if (!tables) return null
        schemas.set(dataSourceId, { version, tables })
        await (await db()).put(SCHEMAS, { version, tables }, dataSourceId).catch(() => {})
        return tables
      })
      inFlight.set(key, p)
    }
    return p
  }
  if (fresh) return (await refresh()) ?? kept?.tables ?? null
  if (kept?.version === version) return kept.tables
  try {
    const stored = (await (await db()).get(SCHEMAS, dataSourceId)) as KeptSchema | IntrospectedTable[] | undefined
    if (stored && !Array.isArray(stored) && stored.version === version) {
      schemas.set(dataSourceId, stored)
      void refresh()
      return stored.tables
    }
  } catch {
    // No database: ask the server.
  }
  return refresh()
}
