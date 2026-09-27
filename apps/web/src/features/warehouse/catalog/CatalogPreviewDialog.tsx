import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import type { DataCatalog, CatalogResultCache } from '@/types'
import { useCatalogPublish } from './use-catalog-publish'

/** The published HTML catalog, previewed as it will be downloaded. */
export function CatalogPreviewDialog({
  catalog,
  cache,
  open,
  onOpenChange,
}: {
  catalog: DataCatalog
  cache: CatalogResultCache
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { buildHtml, downloadHtml, downloadZip, zipLoading } = useCatalogPublish(catalog, cache)
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void buildHtml().then((h) => { if (!cancelled) setHtml(h) })
    return () => { cancelled = true }
  }, [open, buildHtml])

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      // Wide enough for the catalog's own layout (a ~1200 px page) without a
      // horizontal scroll inside the frame.
      className="sm:max-w-[min(1320px,96vw)]"
      title={t('data_catalog.export_preview_title')}
      cancelLabel={t('common.close')}
      footerExtra={
        <div className="flex items-center gap-2 sm:mr-auto">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void downloadHtml()}>
            <Download size={14} />
            {t('data_catalog.export_download_html')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={zipLoading} onClick={() => void downloadZip()}>
            <Archive size={14} />
            {zipLoading ? t('data_catalog.export_generating') : t('data_catalog.export_download_zip')}
          </Button>
        </div>
      }
    >
      <div className="relative h-full min-h-0 overflow-hidden rounded-md border bg-muted">
        {html ? (
          // Scripts run (tabs, filters, sorting) and the page's CSV buttons may
          // download, but nothing else: no same-origin access to the app, no
          // navigation, no forms.
          <iframe srcDoc={html} className="h-full w-full border-0" title={t('data_catalog.export_preview_title')} sandbox="allow-scripts allow-downloads allow-popups" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('data_catalog.export_generating')}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
