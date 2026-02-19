import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Eye, EyeOff, FileText, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
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
  const [includeJsonLd, setIncludeJsonLd] = useState(true)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)

  const threshold = catalog.anonymization.threshold

  // Anonymization impact preview
  const impact = useMemo(() => {
    const retained = cache.rows.filter((r) => r.patientCount >= threshold)
    const suppressed = cache.rows.length - retained.length
    const retainedConcepts = new Set(retained.map((r) => r.conceptId)).size
    const totalConcepts = new Set(cache.rows.map((r) => r.conceptId)).size
    return { retained: retained.length, suppressed, retainedConcepts, totalConcepts }
  }, [cache.rows, threshold])

  const handleDownload = () => {
    const html = generateCatalogHtml({
      catalog,
      cache,
      schemaMapping,
      includeJsonLd,
    })
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${catalog.name.replace(/\s+/g, '-').toLowerCase()}-catalog.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handlePreview = () => {
    const html = generateCatalogHtml({
      catalog,
      cache,
      schemaMapping,
      includeJsonLd,
    })
    setPreviewHtml(html)
  }

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
          {/* Include JSON-LD toggle */}
          <div className="flex items-center gap-3">
            <Switch checked={includeJsonLd} onCheckedChange={setIncludeJsonLd} />
            <Label className="text-sm">{t('data_catalog.export_include_jsonld')}</Label>
          </div>

          {/* Anonymization summary */}
          <div className="flex items-center gap-2 rounded-lg border p-3">
            <ShieldCheck size={14} className="shrink-0 text-muted-foreground" />
            <div className="flex-1 text-xs">
              <span className="font-medium">{t('data_catalog.threshold')}: {threshold}</span>
              <span className="ml-3 text-muted-foreground">
                <Eye size={12} className="mr-0.5 inline" />
                {impact.retained.toLocaleString()} {t('data_catalog.export_rows_retained')}
              </span>
              {impact.suppressed > 0 && (
                <span className="ml-3 text-red-500">
                  <EyeOff size={12} className="mr-0.5 inline" />
                  {impact.suppressed.toLocaleString()} {t('data_catalog.export_rows_suppressed')}
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

      {/* HTML preview iframe */}
      {previewHtml && (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-xs font-medium text-muted-foreground">{t('data_catalog.export_preview_title')}</span>
            <Button variant="ghost" size="sm" onClick={() => setPreviewHtml(null)} className="text-xs">
              {t('common.close')}
            </Button>
          </div>
          <iframe
            srcDoc={previewHtml}
            className="h-[600px] w-full border-0"
            title="Catalog preview"
            sandbox="allow-scripts"
          />
        </Card>
      )}
    </div>
  )
}
