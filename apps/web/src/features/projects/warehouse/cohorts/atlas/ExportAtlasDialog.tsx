import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, AlertTriangle, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { exportToAtlas } from './atlas-converter'
import type { Cohort } from '@/types'

interface ExportAtlasDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cohort: Cohort
}

export function ExportAtlasDialog({ open, onOpenChange, cohort }: ExportAtlasDialogProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const result = useMemo(() => {
    if (!open) return null
    return exportToAtlas(cohort)
  }, [open, cohort])

  const jsonStr = useMemo(() => {
    if (!result) return ''
    return JSON.stringify(result.json, null, 2)
  }, [result])

  const handleDownload = () => {
    if (!jsonStr) return
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${cohort.name || 'cohort'}-atlas.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonStr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('cohorts.atlas_export_title')}</DialogTitle>
          <DialogDescription>{t('cohorts.atlas_export_description')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 space-y-3 overflow-hidden">
          {/* Warnings */}
          {result && result.warnings.length > 0 && (
            <div className="space-y-1 rounded-md bg-yellow-500/10 px-3 py-2">
              <p className="text-xs font-medium text-yellow-700 dark:text-yellow-400">
                <AlertTriangle size={12} className="inline mr-1" />
                {t('cohorts.atlas_warnings', { count: result.warnings.length })}
              </p>
              <ul className="space-y-0.5">
                {result.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-yellow-600 dark:text-yellow-300">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* JSON preview */}
          <div className="h-80 min-h-0 rounded-md border overflow-hidden">
            <CodeEditor
              language="json"
              value={jsonStr}
              readOnly
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5 text-xs">
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t('common.copied') : t('cohorts.atlas_copy')}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button onClick={handleDownload} className="gap-1.5">
            <Download size={14} />
            {t('cohorts.atlas_download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
