import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Download, Eye, FileText, Loader2, Upload } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FieldInfo } from '@/components/ui/field-info'
import { SectionLabel } from '@/components/ui/section-label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { DataCatalog, CatalogResultCache } from '@/types'
import { PUBLICATION_FILE_NAMES, useCatalogPublish } from './use-catalog-publish'
import { CatalogPagesCard } from './CatalogPagesCard'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
  onOpenVersioning?: () => void
}

export function CatalogExportTab({ catalog, cache, onOpenVersioning }: Props) {
  const { t } = useTranslation()
  const { buildHtml, downloadHtml, downloadZip, zipLoading, publishSite, disableSite, siteSaving } = useCatalogPublish(catalog, cache)
  const [html, setHtml] = useState<string | null>(null)
  const [view, setView] = useState<'preview' | 'export'>('preview')

  useEffect(() => {
    let cancelled = false
    void buildHtml().then((h) => { if (!cancelled) setHtml(h) })
    return () => { cancelled = true }
  }, [buildHtml])

  return (
    <Tabs value={view} onValueChange={(v) => setView(v as 'preview' | 'export')} className="flex h-full min-h-0 w-full flex-col gap-3 py-4">
      <div className="flex shrink-0 justify-center">
        <TabsList>
          <TabsTrigger value="preview"><Eye size={14} />{t('data_catalog.publish_preview')}</TabsTrigger>
          <TabsTrigger value="export"><Upload size={14} />{t('data_catalog.publish_export')}</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="preview" className="m-0 min-h-0 flex-1">
        {/* The preview is the downloaded file itself. */}
        <div className="relative h-full min-h-[480px] overflow-hidden rounded-md border bg-muted">
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
      </TabsContent>

      <TabsContent value="export" className="m-0">
        <div className="mx-auto grid w-full max-w-4xl gap-3">
          <Card className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-1.5">
              <FileText size={14} className="text-muted-foreground" />
              <SectionLabel as="h3">{t('data_catalog.export_html_title')}</SectionLabel>
              <FieldInfo text={t('data_catalog.export_html_description')} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TooltipProvider delayDuration={500}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" className="gap-1.5" onClick={() => void downloadZip()} disabled={zipLoading}>
                      <Archive size={14} />
                      {zipLoading ? t('data_catalog.export_generating') : t('data_catalog.export_download_zip')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('data_catalog.export_zip_contents_list', { files: PUBLICATION_FILE_NAMES.join(', ') })}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void downloadHtml()}>
                <Download size={14} />
                {t('data_catalog.export_download_html')}
              </Button>
            </div>
          </Card>

          <CatalogPagesCard
            catalog={catalog}
            publishSite={publishSite}
            disableSite={disableSite}
            siteSaving={siteSaving}
            onOpenVersioning={onOpenVersioning}
          />
        </div>
      </TabsContent>
    </Tabs>
  )
}
