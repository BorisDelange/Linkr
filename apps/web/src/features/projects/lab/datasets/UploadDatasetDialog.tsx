import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, FileSpreadsheet } from 'lucide-react'
import Papa from 'papaparse'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn } from '@/types'

interface UploadDatasetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

interface ParsedData {
  fileName: string
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  preview: Record<string, unknown>[]
}

function inferColumnType(values: unknown[]): DatasetColumn['type'] {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (nonNull.length === 0) return 'unknown'

  let allNumbers = true
  let allBooleans = true

  for (const v of nonNull.slice(0, 100)) {
    const s = String(v).trim()
    if (allNumbers && isNaN(Number(s))) allNumbers = false
    if (allBooleans && !['true', 'false', '0', '1'].includes(s.toLowerCase())) allBooleans = false
    if (!allNumbers && !allBooleans) break
  }

  if (allNumbers) return 'number'
  if (allBooleans) return 'boolean'
  return 'string'
}

export function UploadDatasetDialog({ open, onOpenChange, parentId }: UploadDatasetDialogProps) {
  const { t } = useTranslation()
  const [parsed, setParsed] = useState<ParsedData | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const parseCSV = useCallback((file: File) => {
    setLoading(true)
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: (result) => {
        const headers = result.meta.fields ?? []
        const rows = result.data as Record<string, unknown>[]

        const columns: DatasetColumn[] = headers.map((name, idx) => {
          const values = rows.map((r) => r[name])
          return {
            id: `col-${Date.now()}-${idx}`,
            name,
            type: inferColumnType(values),
            order: idx,
          }
        })

        // Remap rows to use column IDs as keys
        const remappedRows = rows.map((row) => {
          const newRow: Record<string, unknown> = {}
          columns.forEach((col) => {
            newRow[col.id] = row[col.name]
          })
          return newRow
        })

        setParsed({
          fileName: file.name,
          columns,
          rows: remappedRows,
          preview: remappedRows.slice(0, 5),
        })
        setLoading(false)
      },
      error: () => {
        setLoading(false)
      },
    })
  }, [])

  const handleFile = useCallback(
    (file: File) => {
      if (file.name.endsWith('.csv') || file.name.endsWith('.tsv') || file.type === 'text/csv') {
        parseCSV(file)
      }
    },
    [parseCSV],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile],
  )

  const handleImport = useCallback(() => {
    if (!parsed) return
    const { createFile: cf, importData: imp } = useDatasetStore.getState()
    cf(parsed.fileName, parentId)
    // Get the newly created file ID
    const state = useDatasetStore.getState()
    const newFile = state.files[state.files.length - 1]
    if (newFile) {
      imp(newFile.id, parsed.columns, parsed.rows)
    }
    setParsed(null)
    onOpenChange(false)
  }, [parsed, parentId, onOpenChange])

  const handleClose = useCallback(() => {
    setParsed(null)
    onOpenChange(false)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('datasets.upload_dataset')}</DialogTitle>
          <DialogDescription>{t('datasets.upload_description')}</DialogDescription>
        </DialogHeader>

        {!parsed ? (
          <div
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
              dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            {loading ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <>
                <Upload size={24} className="text-muted-foreground" />
                <p className="mt-3 text-sm text-muted-foreground">
                  {t('datasets.drag_drop_or')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t('datasets.browse_files')}
                </Button>
                <p className="mt-2 text-[10px] text-muted-foreground">CSV, TSV</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFile(file)
                    e.target.value = ''
                  }}
                />
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* File info */}
            <div className="flex items-center gap-2 rounded-md border p-2">
              <FileSpreadsheet size={16} className="text-emerald-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{parsed.fileName}</p>
                <p className="text-[10px] text-muted-foreground">
                  {parsed.rows.length} {t('datasets.rows')} · {parsed.columns.length} {t('datasets.columns')}
                </p>
              </div>
            </div>

            {/* Preview table */}
            <div className="max-h-40 overflow-auto rounded border">
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    {parsed.columns.map((col) => (
                      <th key={col.id} className="border-b px-2 py-1 text-left font-medium whitespace-nowrap">
                        {col.name}
                        <span className="ml-1 text-[10px] text-muted-foreground font-normal">{col.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.preview.map((row, i) => (
                    <tr key={i}>
                      {parsed.columns.map((col) => (
                        <td key={col.id} className="border-b px-2 py-0.5 whitespace-nowrap">
                          {row[col.id] != null ? String(row[col.id]) : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          {parsed && (
            <Button onClick={handleImport}>
              {t('datasets.import')} ({parsed.rows.length} {t('datasets.rows')})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
