/**
 * The Export control beside Cancel / Save in an analysis.
 *
 * What it offers depends on what the analysis produced: every analysis renders
 * to a DOM node, so PNG is always available, while copy and LaTeX only appear
 * when the analysis knows its own tabular structure. Offering a greyed-out
 * "Copy as table" on a scatter plot would be noise.
 *
 * PNG goes through the dashboard's own `figure-export`, so a figure exported
 * from an analysis and the same figure exported from a dashboard come out
 * identical. Note `findWidgetNode` there keys off `[data-widget-id]`, which this
 * page does not set — hence passing the node straight to `nodeToBlob`.
 */

import { useCallback, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download, FileCode, Image } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { nodeToBlob, sanitizeFilename } from '@/features/projects/dashboard/figure-export'
import { downloadBlob } from '@/lib/entity-io'
import { copyTableToClipboard, toLatex, type ExportTable } from '@/lib/table-export'

export function AnalysisExportMenu({
  name,
  nodeRef,
  getTable,
}: {
  /** Analysis name, used as the file name. */
  name: string
  /** The node to rasterize. */
  nodeRef: RefObject<HTMLElement | null>
  /**
   * The analysis's tabular form, when it has one. Its absence is what hides the
   * copy and LaTeX entries — a chart has no rows to copy.
   */
  getTable?: () => ExportTable | null
}) {
  const { t } = useTranslation()
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const flash = useCallback((what: string) => {
    setDone(what)
    window.setTimeout(() => setDone((d) => (d === what ? null : d)), 1500)
  }, [])

  const exportPng = useCallback(async () => {
    const node = nodeRef.current
    if (!node || busy) return
    setBusy(true)
    try {
      const blob = await nodeToBlob(node, 'png')
      downloadBlob(blob, `${sanitizeFilename(name)}.png`)
      flash('png')
    } finally {
      setBusy(false)
    }
  }, [nodeRef, name, busy, flash])

  const copyTable = useCallback(async () => {
    const table = getTable?.()
    if (!table) return
    await copyTableToClipboard(table)
    flash('copy')
  }, [getTable, flash])

  const copyLatex = useCallback(async () => {
    const table = getTable?.()
    if (!table) return
    await navigator.clipboard.writeText(toLatex(table))
    flash('latex')
  }, [getTable, flash])

  const hasTable = !!getTable?.()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs">
          {done ? <Check size={12} className="text-green-500" /> : <Download size={12} />}
          {t('common.export')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void exportPng()} disabled={busy}>
          <Image size={14} />
          {t('datasets.export_png')}
        </DropdownMenuItem>
        {hasTable && (
          <>
            <DropdownMenuItem onClick={() => void copyTable()}>
              <Copy size={14} />
              {t('datasets.export_copy_table')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copyLatex()}>
              <FileCode size={14} />
              {t('datasets.export_latex')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
