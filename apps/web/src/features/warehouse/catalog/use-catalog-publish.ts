import { useCallback, useRef, useState } from 'react'
import JSZip from 'jszip'
import { useDataSourceStore } from '@/stores/data-source-store'
import { generateCatalogHtml, buildConceptsCsv, buildDimensionsCsv } from '@/lib/dcat-ap/export-html'
import { buildJsonLd } from '@/lib/dcat-ap/jsonld'
import { discoverFullSchema, type IntrospectedTable } from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'
import type { DataCatalog, CatalogResultCache } from '@/types'

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Builds the published catalog (standalone HTML, or the ZIP with CSVs and JSON-LD) and downloads it. */
export function useCatalogPublish(catalog: DataCatalog, cache: CatalogResultCache | null) {
  const schemaMapping = useDataSourceStore((s) => s.dataSources.find((ds) => ds.id === catalog.dataSourceId)?.schemaMapping)
  const [zipLoading, setZipLoading] = useState(false)
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

  const downloadHtml = useCallback(async () => {
    const html = await buildHtml()
    if (html) downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseName}-catalog.html`)
  }, [buildHtml, baseName])

  const downloadZip = useCallback(async () => {
    if (!cache) return
    setZipLoading(true)
    try {
      const fullSchema = await getFullSchema()
      const zip = new JSZip()
      zip.file('catalog.html', generateCatalogHtml({ catalog, cache, schemaMapping, fullSchema }))
      zip.file('concepts.csv', buildConceptsCsv(cache.concepts, catalog))
      zip.file('dimensions.csv', buildDimensionsCsv(cache.dimensions, catalog))
      const jsonld = buildJsonLd({ metadata: catalog.dcatApMetadata ?? {}, schemaMapping, cache, catalog, fullSchema })
      zip.file('metadata.jsonld', JSON.stringify(jsonld, null, 2))
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${baseName}-catalog.zip`)
    } finally {
      setZipLoading(false)
    }
  }, [catalog, cache, schemaMapping, getFullSchema, baseName])

  return { buildHtml, downloadHtml, downloadZip, zipLoading }
}
