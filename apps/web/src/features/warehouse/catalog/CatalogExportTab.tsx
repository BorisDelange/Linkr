import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Download, Eye, FileCode, Languages, Loader2, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FieldInfo } from '@/components/ui/field-info'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PAGE_LOCALES, pageLocaleOf, type PageLocale } from '@/lib/dcat-ap/page-text'
import type { DataCatalog, CatalogResultCache } from '@/types'
import { useCatalogPublish } from './use-catalog-publish'
import { PAGE_DATA_MESSAGE, PAGE_READY_MESSAGE, type CatalogPageData } from '@/lib/dcat-ap/export-html'
import { CatalogPagesCard } from './CatalogPagesCard'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
  /** The tab stays mounted once visited; the preview is only rebuilt while it shows. */
  active: boolean
  onOpenVersioning?: () => void
}

/** Each language in its own name, as language pickers show them. */
const LOCALE_NAMES: Record<PageLocale, string> = { en: 'English', fr: 'Français' }

export function CatalogExportTab({ catalog, cache, active, onOpenVersioning }: Props) {
  const { t, i18n } = useTranslation()
  const { buildPreview, downloadHtml, downloadZip, zipLoading, publishSite, disableSite, siteSaving } = useCatalogPublish(catalog, cache)
  const [preview, setPreview] = useState<{ html: string; data: CatalogPageData } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [view, setView] = useState<'preview' | 'export'>('preview')
  // The preview follows the app; what leaves the app is in the language picked here.
  const previewLocale = pageLocaleOf(i18n.language)
  const [exportLocale, setExportLocale] = useState<PageLocale>(previewLocale)
  // What the masks hide, in the preview only: the files never carry it.
  const [reveal, setReveal] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void buildPreview(previewLocale, { reveal }).then((p) => { if (!cancelled) setPreview(p) })
    return () => { cancelled = true }
  }, [active, buildPreview, previewLocale, reveal])

  // The page asks for its data once its script runs; it answers only this frame.
  useEffect(() => {
    if (!preview) return
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || (e.data as { type?: string } | null)?.type !== PAGE_READY_MESSAGE) return
      frame.current?.contentWindow?.postMessage({ type: PAGE_DATA_MESSAGE, data: preview.data }, '*')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [preview])

  return (
    <Tabs value={view} onValueChange={(v) => setView(v as 'preview' | 'export')} className="flex h-full min-h-0 w-full flex-col gap-3 py-4">
      <div className="relative flex shrink-0 justify-center">
        <TabsList>
          <TabsTrigger value="preview"><Eye size={14} />{t('data_catalog.publish_preview')}</TabsTrigger>
          <TabsTrigger value="export"><Upload size={14} />{t('data_catalog.publish_export')}</TabsTrigger>
        </TabsList>
        {view === 'preview' && (
          <div className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-2">
            <Switch id="catalog-preview-reveal" checked={reveal} onCheckedChange={setReveal} />
            <Label htmlFor="catalog-preview-reveal">{t('data_catalog.preview_reveal')}</Label>
            <FieldInfo text={t('data_catalog.preview_reveal_hint')} />
          </div>
        )}
      </div>

      <TabsContent value="preview" className="m-0 min-h-0 flex-1">
        {/* The preview is the downloaded file itself. */}
        <div className="relative h-full min-h-[480px] overflow-hidden rounded-md border bg-muted">
          {preview ? (
            // Scripts run (tabs, filters, sorting) and the page's CSV buttons may
            // download, but nothing else: no same-origin access to the app, no
            // navigation, no forms.
            <iframe ref={frame} srcDoc={preview.html} className="h-full w-full border-0" title={t('data_catalog.export_preview_title')} sandbox="allow-scripts allow-downloads allow-popups" />
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
          <Card className="flex flex-row items-center gap-3 p-4">
            <Languages size={14} className="text-muted-foreground" />
            <Label htmlFor="catalog-page-locale">{t('data_catalog.export_language')}</Label>
            <FieldInfo text={t('data_catalog.export_language_hint')} />
            <span className="flex-1" />
            <Select value={exportLocale} onValueChange={(v) => setExportLocale(v as PageLocale)}>
              <SelectTrigger id="catalog-page-locale" className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAGE_LOCALES.map((l) => <SelectItem key={l} value={l} className="text-xs">{LOCALE_NAMES[l]}</SelectItem>)}
              </SelectContent>
            </Select>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <ExportCard
              icon={<Archive size={16} className="shrink-0 text-amber-500" />}
              headClassName="bg-amber-50 dark:bg-amber-950/30"
              title={t('data_catalog.export_zip_title')}
              extension=".zip"
              description={t('data_catalog.export_zip_description')}
              files={[
                ['catalog.html', t('data_catalog.export_file_html')],
                ['concepts.csv', t('data_catalog.export_file_concepts')],
                ['crossings/*.csv', t('data_catalog.export_file_crossings')],
                ['metadata.jsonld', t('data_catalog.export_file_jsonld')],
              ]}
              action={
                <Button className="w-full" variant="outline" size="sm" onClick={() => void downloadZip(exportLocale)} disabled={zipLoading}>
                  {zipLoading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {zipLoading ? t('data_catalog.export_generating') : t('data_catalog.export_download_zip')}
                </Button>
              }
            />
            <ExportCard
              icon={<FileCode size={16} className="shrink-0 text-sky-500" />}
              headClassName="bg-sky-50 dark:bg-sky-950/30"
              title={t('data_catalog.export_html_title')}
              extension=".html"
              description={t('data_catalog.export_html_description')}
              action={
                <Button className="w-full" variant="outline" size="sm" onClick={() => void downloadHtml(exportLocale)}>
                  <Download size={14} />
                  {t('data_catalog.export_download_html')}
                </Button>
              }
            />
          </div>

          <CatalogPagesCard
            catalog={catalog}
            publishSite={(provider) => publishSite(provider, exportLocale)}
            disableSite={disableSite}
            siteSaving={siteSaving}
            onOpenVersioning={onOpenVersioning}
          />
        </div>
      </TabsContent>
    </Tabs>
  )
}

/** One download format, laid out like the concept-mapping export cards. */
function ExportCard({ icon, headClassName, title, extension, description, files, action }: {
  icon: ReactNode
  headClassName: string
  title: string
  extension: string
  description: string
  /** What the download holds, as [file, what it is]. */
  files?: [string, string][]
  action: ReactNode
}) {
  return (
    <Card className="flex flex-col justify-between gap-0 overflow-hidden p-0">
      <div className={cn('flex items-center gap-2.5 px-4 py-3', headClassName)}>
        {icon}
        <span className="text-sm font-medium">{title}</span>
        <Badge variant="outline" className="ml-auto">{extension}</Badge>
      </div>
      <div className="flex-1 space-y-2 px-4 py-3">
        <p className="text-xs text-muted-foreground">{description}</p>
        {files && (
          <ul className="space-y-1">
            {files.map(([file, what]) => (
              <li key={file} className="flex gap-2 text-xs">
                <code className="shrink-0 font-mono text-foreground">{file}</code>
                <span className="text-muted-foreground">{what}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="px-4 pb-4">{action}</div>
    </Card>
  )
}
