import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Eye, EyeOff, FileText, ShieldCheck, Replace } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDataSourceStore } from '@/stores/data-source-store'
import { generateCatalogHtml } from '@/lib/dcat-ap/export-html'
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

  const threshold = catalog.anonymization.threshold
  const mode = catalog.anonymization.mode ?? 'replace'

  // Anonymization impact preview
  const impact = useMemo(() => {
    const affected = cache.rows.filter((r) => r.patientCount < threshold)
    const unaffected = cache.rows.length - affected.length
    const retainedConcepts = mode === 'suppress'
      ? new Set(cache.rows.filter((r) => r.patientCount >= threshold).map((r) => r.conceptId)).size
      : new Set(cache.rows.map((r) => r.conceptId)).size
    const totalConcepts = new Set(cache.rows.map((r) => r.conceptId)).size
    return { affected: affected.length, unaffected, retainedConcepts, totalConcepts }
  }, [cache.rows, threshold, mode])

  const handleDownload = () => {
    const html = generateCatalogHtml({ catalog, cache, schemaMapping })
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${catalog.name.replace(/\s+/g, '-').toLowerCase()}-catalog.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handlePreview = useCallback(() => {
    const html = generateCatalogHtml({ catalog, cache, schemaMapping })
    setPreviewHtml(html)
  }, [catalog, cache, schemaMapping])

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
                      <Replace size={12} className="mr-0.5 inline" />
                      {impact.affected.toLocaleString()} {t('data_catalog.export_rows_replaced')}
                    </span>
                  ) : (
                    <span className="text-red-500">
                      <EyeOff size={12} className="mr-0.5 inline" />
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
            <Button onClick={handleDownload}>
              <Download size={14} />
              {t('data_catalog.export_download')}
            </Button>
            <Button variant="outline" onClick={handlePreview}>
              <Eye size={14} />
              {t('data_catalog.export_preview')}
            </Button>
          </div>
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
