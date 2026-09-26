import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Download, Eye, FileText, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FieldInfo } from '@/components/ui/field-info'
import { SectionLabel } from '@/components/ui/section-label'
import type { DataCatalog, CatalogResultCache } from '@/types'
import { useCatalogPublish } from './use-catalog-publish'
import { CatalogPreviewDialog } from './CatalogPreviewDialog'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

export function CatalogExportTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const { downloadHtml, downloadZip, zipLoading } = useCatalogPublish(catalog, cache)
  const [previewOpen, setPreviewOpen] = useState(false)

  const threshold = catalog.anonymization.threshold
  const mode = catalog.anonymization.mode ?? 'replace'

  const impact = useMemo(() => {
    const allRows = [...cache.concepts, ...cache.dimensions]
    const affected = allRows.filter((r) => r.patientCount < threshold).length
    const retainedConcepts = mode === 'suppress'
      ? cache.concepts.filter((r) => r.patientCount >= threshold).length
      : cache.concepts.length
    return { affected, retainedConcepts, totalConcepts: cache.concepts.length }
  }, [cache.concepts, cache.dimensions, threshold, mode])

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-4">
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-1.5">
          <FileText size={14} className="text-muted-foreground" />
          <SectionLabel as="h3">{t('data_catalog.export_html_title')}</SectionLabel>
          <FieldInfo text={t('data_catalog.export_html_description')} />
        </div>

        {/* What the anonymisation will do to this export */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <ShieldCheck size={14} className="shrink-0 text-muted-foreground" />
          <span className="font-medium">{t('data_catalog.threshold')}: {threshold}</span>
          <span className="text-muted-foreground">
            {mode === 'replace' ? t('data_catalog.anon_mode_replace') : t('data_catalog.anon_mode_suppress')}
          </span>
          {impact.affected > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {impact.affected.toLocaleString()} {mode === 'replace' ? t('data_catalog.export_rows_replaced') : t('data_catalog.export_rows_suppressed')}
            </span>
          )}
          <span className="text-muted-foreground">
            {impact.retainedConcepts.toLocaleString()} / {impact.totalConcepts.toLocaleString()} {t('data_catalog.export_concepts')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="gap-1.5" onClick={() => void downloadZip()} disabled={zipLoading}>
            <Archive size={14} />
            {zipLoading ? t('data_catalog.export_generating') : t('data_catalog.export_download_zip')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void downloadHtml()}>
            <Download size={14} />
            {t('data_catalog.export_download_html')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPreviewOpen(true)}>
            <Eye size={14} />
            {t('data_catalog.export_preview')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('data_catalog.export_zip_contents')}</p>
      </Card>

      <CatalogPreviewDialog catalog={catalog} cache={cache} open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  )
}
