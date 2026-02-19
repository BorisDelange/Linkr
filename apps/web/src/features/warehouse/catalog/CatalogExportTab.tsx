import { useState, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Eye, FileText, Archive, ShieldCheck } from 'lucide-react'
import JSZip from 'jszip'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDataSourceStore } from '@/stores/data-source-store'
import { generateCatalogHtml, buildConceptsCsv, buildDimensionsCsv } from '@/lib/dcat-ap/export-html'
import { buildJsonLd } from '@/lib/dcat-ap/jsonld'
import { discoverFullSchema, type IntrospectedTable } from '@/lib/duckdb/engine'
import type { DataCatalog, CatalogResultCache } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

export function CatalogExportTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const schemaMapping = dataSources.find((ds) => ds.id === catalog.dataSourceId)?.schemaMapping
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [zipLoading, setZipLoading] = useState(false)

  // Cache introspected schema across exports (fetched once per session)
  const schemaCache = useRef<IntrospectedTable[] | null>(null)

  const getFullSchema = async (): Promise<IntrospectedTable[] | null> => {
    if (schemaCache.current) return schemaCache.current
    try {
      const schema = await discoverFullSchema(catalog.dataSourceId)
      schemaCache.current = schema
      return schema
    } catch {
      return null
    }
  }

  const threshold = catalog.anonymization.threshold
  const mode = catalog.anonymization.mode ?? 'replace'

  // Anonymization impact preview
  const impact = useMemo(() => {
    const allRows = [...cache.concepts, ...cache.dimensions]
    const affected = allRows.filter((r) => r.patientCount < threshold)
    const unaffected = allRows.length - affected.length
    const retainedConcepts = mode === 'suppress'
      ? cache.concepts.filter((r) => r.patientCount >= threshold).length
      : cache.concepts.length
    const totalConcepts = cache.concepts.length
    return { affected: affected.length, unaffected, retainedConcepts, totalConcepts }
  }, [cache.concepts, cache.dimensions, threshold, mode])

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const baseName = catalog.name.replace(/\s+/g, '-').toLowerCase()

  const handleDownload = useCallback(async () => {
    const fullSchema = await getFullSchema()
    const html = generateCatalogHtml({ catalog, cache, schemaMapping, fullSchema })
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseName}-catalog.html`)
  }, [catalog, cache, schemaMapping, baseName])

  const handlePreview = useCallback(async () => {
    const fullSchema = await getFullSchema()
    const html = generateCatalogHtml({ catalog, cache, schemaMapping, fullSchema })
    setPreviewHtml(html)
  }, [catalog, cache, schemaMapping])

  const handleDownloadZip = useCallback(async () => {
    setZipLoading(true)
    try {
      const fullSchema = await getFullSchema()
      const zip = new JSZip()

      // HTML catalog
      const html = generateCatalogHtml({ catalog, cache, schemaMapping, fullSchema })
      zip.file('catalog.html', html)

      // CSV files
      zip.file('concepts.csv', buildConceptsCsv(cache.concepts, catalog))
      zip.file('dimensions.csv', buildDimensionsCsv(cache.dimensions, catalog))

      // JSON-LD metadata
      const metadata = catalog.dcatApMetadata ?? {}
      const jsonld = buildJsonLd({ metadata, schemaMapping, cache, catalog, fullSchema })
      zip.file('metadata.jsonld', JSON.stringify(jsonld, null, 2))

      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${baseName}-catalog.zip`)
    } finally {
      setZipLoading(false)
    }
  }, [catalog, cache, schemaMapping, baseName])

  return (
    <div className="space-y-4">
      {/* Export options */}
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('data_catalog.export_html_title')}</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('data_catalog.export_html_description')}
        </p>

        <div className="mt-4 space-y-3">
          {/* Anonymization summary */}
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <ShieldCheck size={14} className="shrink-0 text-muted-foreground" />
            <div className="flex-1 text-xs">
              <span className="font-medium">{t('data_catalog.threshold')}: {threshold}</span>
              <span className="ml-2 text-muted-foreground">
                ({mode === 'replace' ? t('data_catalog.anon_mode_replace') : t('data_catalog.anon_mode_suppress')})
              </span>
              {impact.affected > 0 && (
                <span className="ml-3">
                  {mode === 'replace' ? (
                    <span className="text-amber-500">
                      {impact.affected.toLocaleString()} {t('data_catalog.export_rows_replaced')}
                    </span>
                  ) : (
                    <span className="text-red-500">
                      {impact.affected.toLocaleString()} {t('data_catalog.export_rows_suppressed')}
                    </span>
                  )}
                </span>
              )}
              <span className="ml-3 text-muted-foreground">
                {impact.retainedConcepts} / {impact.totalConcepts} {t('data_catalog.export_concepts')}
              </span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button onClick={handleDownloadZip} disabled={zipLoading}>
              <Archive size={14} />
              {zipLoading ? t('data_catalog.export_generating') : t('data_catalog.export_download_zip')}
            </Button>
            <Button variant="outline" onClick={handleDownload}>
              <Download size={14} />
              {t('data_catalog.export_download_html')}
            </Button>
            <Button variant="outline" onClick={handlePreview}>
              <Eye size={14} />
              {t('data_catalog.export_preview')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('data_catalog.export_zip_contents')}
          </p>
        </div>
      </Card>

      {/* HTML preview modal */}
      <Dialog open={previewHtml !== null} onOpenChange={(open) => { if (!open) setPreviewHtml(null) }}>
        <DialogContent className="!top-0 !left-0 !translate-x-0 !translate-y-0 !max-w-none flex h-screen max-h-screen w-screen flex-col gap-0 rounded-none border-0 p-0">
          <DialogHeader className="shrink-0 border-b px-4 py-3">
            <DialogTitle className="text-sm">{t('data_catalog.export_preview_title')}</DialogTitle>
          </DialogHeader>
          <iframe
            srcDoc={previewHtml ?? undefined}
            className="min-h-0 flex-1 border-0"
            title="Catalog preview"
            sandbox="allow-scripts"
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
