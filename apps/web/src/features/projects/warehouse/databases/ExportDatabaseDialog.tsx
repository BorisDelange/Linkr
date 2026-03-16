import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DataSource } from '@/types'
import type { ExportProgress } from '@/lib/duckdb/export-database'
import { exportAsParquetZip } from '@/lib/duckdb/export-database'

interface ExportDatabaseDialogProps {
  source: DataSource | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ExportState = 'idle' | 'exporting' | 'done' | 'error'

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ExportDatabaseDialog({ source, open, onOpenChange }: ExportDatabaseDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<ExportState>('idle')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    setState('idle')
    setProgress(null)
    setErrorMessage(null)
    abortRef.current = null
  }, [])

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        if (state === 'exporting') abortRef.current?.abort()
        setTimeout(reset, 200)
      }
      onOpenChange(nextOpen)
    },
    [state, reset, onOpenChange],
  )

  const handleExport = async () => {
    if (!source) return

    setState('exporting')
    setErrorMessage(null)
    const controller = new AbortController()
    abortRef.current = controller

    const slug =
      source.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'database'

    try {
      const blob = await exportAsParquetZip(source.id, setProgress, controller.signal)
      downloadBlob(blob, `${slug}.zip`)
      setState('done')
    } catch (err) {
      if (controller.signal.aborted) {
        reset()
        return
      }
      setState('error')
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const progressPercent =
    progress && progress.totalTables > 0
      ? Math.round((progress.currentTable / progress.totalTables) * 100)
      : 0

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('databases.download_data_title')}</DialogTitle>
          <DialogDescription>
            {t('databases.download_data_description', { name: source?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {state === 'idle' && (
          <>
            <p className="py-2 text-sm text-muted-foreground">
              {t('databases.download_data_format_parquet_desc')}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleExport}>
                <Download size={14} />
                {t('databases.download_data_start')}
              </Button>
            </DialogFooter>
          </>
        )}

        {state === 'exporting' && progress && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin text-primary" />
              <span className="text-sm">
                {progress.phase === 'discovering' && t('databases.download_data_discovering')}
                {progress.phase === 'exporting' &&
                  t('databases.download_data_table_progress', {
                    current: progress.currentTable,
                    total: progress.totalTables,
                    table: progress.tableName,
                  })}
                {progress.phase === 'packaging' && t('databases.download_data_packaging')}
              </span>
            </div>
            <Progress value={progressPercent} />
            <p className="text-right text-xs text-muted-foreground">{progressPercent}%</p>
          </div>
        )}

        {state === 'done' && (
          <div className="flex flex-col items-center py-6">
            <CheckCircle2 size={32} className="text-green-500" />
            <p className="mt-2 text-sm font-medium">{t('databases.download_data_success')}</p>
            <Button variant="outline" className="mt-4" onClick={() => handleClose(false)}>
              {t('common.close')}
            </Button>
          </div>
        )}

        {state === 'error' && (
          <div className="flex flex-col items-center py-6">
            <XCircle size={32} className="text-destructive" />
            <p className="mt-2 text-sm font-medium">{t('databases.download_data_error')}</p>
            {errorMessage && (
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {errorMessage}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <Button variant="outline" onClick={() => handleClose(false)}>
                {t('common.close')}
              </Button>
              <Button
                onClick={() => {
                  reset()
                  handleExport()
                }}
              >
                {t('databases.download_data_retry')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
