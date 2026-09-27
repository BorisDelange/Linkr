import { openDB, type IDBPDatabase } from 'idb'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { buildCatalogPageData, type CatalogPageData } from './export-html'
import type { PageLocale } from './page-text'
import { perfLog } from './perf'

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
  if (hit?.key === key) {
    perfLog('preview: page data from memory')
    return hit.data
  }
  const t = performance.now()
  const data = buildCatalogPageData({ catalog, cache, locale, reveal })
  perfLog('preview: page data built', t)
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
    blocked: () => perfLog('page store: upgrade blocked by another open tab'),
  })
  return dbPromise
}

/**
 * The database's introspected tables, which the page's Schema tab lists. Asking
 * the server can take seconds on a large warehouse, so the last answer is kept:
 * the page renders from it at once, while a fresh one is fetched for the next
 * render.
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
