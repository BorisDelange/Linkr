import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download, ExternalLink, Quote } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CITATION_FORMATS, LINKR_DOI } from '@/lib/citation'
import { copyText } from '@/lib/clipboard'

const STYLE_FORMATS = CITATION_FORMATS.filter((f) => !f.file)
const FILE_FORMATS = CITATION_FORMATS.filter((f) => f.file)

export function CiteDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [formatId, setFormatId] = useState(CITATION_FORMATS[0].id)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const format = CITATION_FORMATS.find((f) => f.id === formatId) ?? CITATION_FORMATS[0]

  const copy = () => {
    void copyText(format.text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1200)
    })
  }

  const download = () => {
    if (!format.file) return
    const url = URL.createObjectURL(new Blob([format.text], { type: format.file.mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = `linkr-citation.${format.file.extension}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent/50"
      >
        <Quote size={11} />
        <span>{t('footer.cite')}</span>
      </button>
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        kind="settings"
        title={t('footer.cite_title')}
        description={t('footer.cite_hint')}
        onConfirm={copy}
        confirmLabel={
          <>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('common.copied') : t('common.copy')}
          </>
        }
        hideCancel
        footerExtra={
          <a
            href={`https://doi.org/${LINKR_DOI}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink size={12} />
            <span>doi:{LINKR_DOI}</span>
          </a>
        }
      >
        <div className="flex items-center gap-2">
          <Select value={formatId} onValueChange={(v) => { setFormatId(v); setCopied(false) }}>
            <SelectTrigger size="sm" className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t('footer.cite_group_styles')}</SelectLabel>
                {STYLE_FORMATS.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>{t('footer.cite_group_files')}</SelectLabel>
                {FILE_FORMATS.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          {format.file && (
            <Button size="sm" variant="outline" onClick={download}>
              <Download size={14} />
              .{format.file.extension}
            </Button>
          )}
        </div>
        {/* Fixed height so the dialog doesn't jump between a two-line style and a long BibTeX entry. */}
        <pre
          className={cn(
            'h-64 overflow-auto rounded-md border bg-muted/40 p-3 leading-relaxed',
            format.file
              ? 'font-mono text-[10px] whitespace-pre'
              : 'font-sans text-xs whitespace-pre-wrap',
          )}
        >
          {format.text}
        </pre>
      </DialogShell>
    </>
  )
}
