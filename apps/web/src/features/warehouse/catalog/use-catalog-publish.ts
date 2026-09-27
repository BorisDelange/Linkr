import { useCallback, useRef, useState } from 'react'
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
import type { DataCatalog, CatalogResultCache, SchemaMapping } from '@/types'

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

interface PublicationContext {
  catalog: DataCatalog
  cache: CatalogResultCache
  schemaMapping: SchemaMapping | undefined
  fullSchema: IntrospectedTable[] | null
}

/** The files of a published catalog, as the ZIP names them. The Pages site is
 *  built from the same list, so both always carry the same files. */
function publicationFiles(ctx: PublicationContext): { name: string; content: string }[] {
  const { catalog, cache, schemaMapping, fullSchema } = ctx
  const published = buildPublishedCatalog(catalog, cache)
  return [
    { name: 'catalog.html', content: generateCatalogHtml(ctx) },
    { name: 'concepts.csv', content: buildConceptsCsv(cache.concepts, catalog) },
    ...published.crossings.map((c) => ({ name: crossingCsvPath(c.id), content: buildCrossingCsv(published, c) })),
    {
      name: 'metadata.jsonld',
      content: JSON.stringify(buildJsonLd({ metadata: catalog.dcatApMetadata ?? {}, schemaMapping, cache, catalog, fullSchema }), null, 2),
    },
  ]
}

export const PUBLICATION_FILE_NAMES = ['catalog.html', 'concepts.csv', crossingCsvPath('…'), 'metadata.jsonld']

/** Builds the published catalog (standalone HTML, the ZIP with CSVs and JSON-LD,
 *  or the Pages site stored with the catalog) from the computed results. */
export function useCatalogPublish(catalog: DataCatalog, cache: CatalogResultCache | null) {
  const schemaMapping = useDataSourceStore((s) => s.dataSources.find((ds) => ds.id === catalog.dataSourceId)?.schemaMapping)
  const updateCatalog = useCatalogStore((s) => s.updateCatalog)
  const [zipLoading, setZipLoading] = useState(false)
  const [siteSaving, setSiteSaving] = useState(false)
  // The introspected schema is the slow part and does not change within a session.
  const schemaCache = useRef<IntrospectedTable[] | null>(null)

  const getFullSchema = useCallback(async (): Promise<IntrospectedTable[] | null> => {
    if (schemaCache.current) return schemaCache.current
    try {
      schemaCache.current = await discoverFullSchema(catalog.dataSourceId)
      return schemaCache.current
    } catch {
      return null
    }
  }, [catalog.dataSourceId])

  const baseName = localized(catalog.name, 'en').replace(/\s+/g, '-').toLowerCase()

  const buildHtml = useCallback(async () => {
    if (!cache) return null
    const fullSchema = await getFullSchema()
    return generateCatalogHtml({ catalog, cache, schemaMapping, fullSchema })
  }, [catalog, cache, schemaMapping, getFullSchema])

  const buildFiles = useCallback(async () => {
    if (!cache) return null
    const ctx: PublicationContext = { catalog, cache, schemaMapping, fullSchema: await getFullSchema() }
    return publicationFiles(ctx)
  }, [catalog, cache, schemaMapping, getFullSchema])

  const downloadHtml = useCallback(async () => {
    const html = await buildHtml()
    if (html) downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseName}-catalog.html`)
  }, [buildHtml, baseName])

  const downloadZip = useCallback(async () => {
    setZipLoading(true)
    try {
      const files = await buildFiles()
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
  const publishSite = useCallback(async (provider: PagesProvider) => {
    setSiteSaving(true)
    try {
      const files = await buildFiles()
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
