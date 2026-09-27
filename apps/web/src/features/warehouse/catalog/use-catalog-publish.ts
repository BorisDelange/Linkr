import { useCallback, useState } from 'react'
import JSZip from 'jszip'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { getStorage } from '@/lib/storage'
import { generateCatalogHtml, buildConceptsCsv } from '@/lib/dcat-ap/export-html'
import { buildCrossingCsv, buildPublishedCatalog, crossingCsvPath } from '@/lib/data-catalog/publish'
import { buildJsonLd } from '@/lib/dcat-ap/jsonld'
import { buildPagesTree, type PagesProvider } from '@/lib/dcat-ap/pages-deployment'
import { clearPagesSite, savePagesSite } from '@/lib/dcat-ap/pages-site-files'
import { discoverFullSchema, type IntrospectedTable } from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'
import { catalogPageKey, getCachedPage, getDatabaseSchema, putCachedPage } from '@/lib/dcat-ap/page-cache'
import type { PageLocale } from '@/lib/dcat-ap/page-text'
import { perfLog } from '@/lib/dcat-ap/perf'
import type { DataCatalog, CatalogResultCache, SchemaMapping } from '@/types'

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// TODO(data-catalog): temporary, with perfLog — what the page's weight is made of.
function logPageWeight(catalog: DataCatalog, cache: CatalogResultCache, locale: PageLocale) {
  const kb = (v: unknown) => Math.round(JSON.stringify(v).length / 1024)
  const published = buildPublishedCatalog(catalog, cache, { locale })
  const rows = [
    { part: 'concepts (list)', kb: kb(cache.concepts), items: cache.concepts.length },
    { part: 'variables (labels)', kb: kb(published.variables), items: Object.keys(published.variables).length },
    ...published.crossings.map((c) => ({ part: `crossing ${c.vars.join(' × ')}`, kb: kb(c.cells), items: c.cells.length })),
  ].sort((a, b) => b.kb - a.kb)
  perfLog('page weight by part (KB, items)')
  console.table(rows)
}

/** Builds under way, so a second caller for the same page waits for the first. */
const pageBuilds = new Map<string, Promise<string>>()

interface PublicationContext {
  catalog: DataCatalog
  cache: CatalogResultCache
  schemaMapping: SchemaMapping | undefined
  fullSchema: IntrospectedTable[] | null
  locale: PageLocale
}

/** The files of a published catalog, as the ZIP names them. The Pages site is
 *  built from the same list, so both always carry the same files. */
function publicationFiles(ctx: PublicationContext): { name: string; content: string }[] {
  const { catalog, cache } = ctx
  const published = buildPublishedCatalog(catalog, cache, { locale: ctx.locale })
  return [
    { name: 'catalog.html', content: generateCatalogHtml(ctx) },
    { name: 'concepts.csv', content: buildConceptsCsv(cache.concepts, catalog) },
    ...published.crossings.map((c) => ({ name: crossingCsvPath(c.id), content: buildCrossingCsv(published, c) })),
    {
      name: 'metadata.jsonld',
      content: JSON.stringify(buildJsonLd({ metadata: catalog.dcatApMetadata ?? {}, schemaMapping: ctx.schemaMapping, cache, catalog, fullSchema: ctx.fullSchema }), null, 2),
    },
  ]
}


/** Builds the published catalog (standalone HTML, the ZIP with CSVs and JSON-LD,
 *  or the Pages site stored with the catalog) from the computed results, in the
 *  page language each call names. */
export function useCatalogPublish(catalog: DataCatalog, cache: CatalogResultCache | null) {
  const schemaMapping = useDataSourceStore((s) => s.dataSources.find((ds) => ds.id === catalog.dataSourceId)?.schemaMapping)
  const updateCatalog = useCatalogStore((s) => s.updateCatalog)
  const [zipLoading, setZipLoading] = useState(false)
  const [siteSaving, setSiteSaving] = useState(false)

  const getFullSchema = useCallback(() => getDatabaseSchema(catalog.dataSourceId, async () => {
    try {
      return await discoverFullSchema(catalog.dataSourceId)
    } catch {
      return null
    }
  }), [catalog.dataSourceId])

  const baseName = localized(catalog.name, 'en').replace(/\s+/g, '-').toLowerCase()

  /** The page, from the cache when nothing it depends on has changed since it was rendered. */
  const buildHtml = useCallback(async (locale: PageLocale, { reveal = false }: { reveal?: boolean } = {}) => {
    if (!cache) return null
    let t = performance.now()
    perfLog('preview: build start')
    const fullSchema = await getFullSchema()
    perfLog('preview: schema', t, `${fullSchema?.length ?? 0} tables`)
    t = performance.now()
    const key = catalogPageKey({ catalog, computedAt: cache.computedAt, schemaMapping, fullSchema, locale })
    perfLog('preview: cache key', t)
    const variant = reveal ? `${locale}:reveal` : locale
    const slot = `${catalog.id}:${variant}:${key}`
    const pending = pageBuilds.get(slot)
    if (pending) return pending
    const build = (async () => {
      let t = performance.now()
      const cached = await getCachedPage(catalog.id, variant, key)
      perfLog(cached ? 'preview: page cache HIT' : 'preview: page cache miss', t)
      if (cached) return cached
      t = performance.now()
      const html = generateCatalogHtml({ catalog, cache, schemaMapping, fullSchema, locale, reveal })
      perfLog('preview: generate', t, `${Math.round(html.length / 1024)} KB`)
      logPageWeight(catalog, cache, locale)
      // Stored in the background: writing tens of megabytes takes seconds, and
      // the page is already in memory for this session.
      t = performance.now()
      void putCachedPage(catalog.id, variant, key, html).then(() => perfLog('preview: page cache write (background)', t))
      return html
    })().finally(() => pageBuilds.delete(slot))
    pageBuilds.set(slot, build)
    return build
  }, [catalog, cache, schemaMapping, getFullSchema])

  const buildFiles = useCallback(async (locale: PageLocale) => {
    if (!cache) return null
    const ctx: PublicationContext = { catalog, cache, schemaMapping, fullSchema: await getFullSchema(), locale }
    return publicationFiles(ctx)
  }, [catalog, cache, schemaMapping, getFullSchema])

  const downloadHtml = useCallback(async (locale: PageLocale) => {
    const html = await buildHtml(locale)
    if (html) downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseName}-catalog.html`)
  }, [buildHtml, baseName])

  const downloadZip = useCallback(async (locale: PageLocale) => {
    setZipLoading(true)
    try {
      const files = await buildFiles(locale)
      if (!files) return
      const zip = new JSZip()
      for (const f of files) zip.file(f.name, f.content)
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${baseName}-catalog.zip`)
    } finally {
      setZipLoading(false)
    }
  }, [buildFiles, baseName])

  /** Renders the site and stores it with the catalog; the next Versioning push
   *  carries it to the repo, whose CI deploys it. */
  const publishSite = useCallback(async (provider: PagesProvider, locale: PageLocale) => {
    setSiteSaving(true)
    try {
      const files = await buildFiles(locale)
      if (!files) return
      await savePagesSite(getStorage(), catalog, buildPagesTree(files, provider, catalog.gitRemoteConfig?.branch))
      await updateCatalog(catalog.id, { pagesDeployment: { provider, updatedAt: new Date().toISOString() } })
    } finally {
      setSiteSaving(false)
    }
  }, [buildFiles, catalog, updateCatalog])

  const disableSite = useCallback(async () => {
    setSiteSaving(true)
    try {
      await clearPagesSite(getStorage(), catalog.id)
      await updateCatalog(catalog.id, { pagesDeployment: null })
    } finally {
      setSiteSaving(false)
    }
  }, [catalog.id, updateCatalog])

  return { buildHtml, downloadHtml, downloadZip, zipLoading, publishSite, disableSite, siteSaving }
}
