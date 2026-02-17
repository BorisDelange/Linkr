import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, FileSpreadsheet, AlertCircle, X, TriangleAlert } from 'lucide-react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn, DatasetFile, DatasetParseOptions } from '@/types'

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
  totalRows: number
}

type Delimiter = 'auto' | ',' | '\t' | ';' | '|'
type Encoding = 'UTF-8' | 'ISO-8859-1' | 'Windows-1252'

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

function buildColumns(headers: string[], rows: Record<string, unknown>[]): DatasetColumn[] {
  return headers.map((name, idx) => {
    const values = rows.map((r) => r[name])
    return {
      id: `col-${Date.now()}-${idx}`,
      name,
      type: inferColumnType(values),
      order: idx,
    }
  })
}

function remapRows(rows: Record<string, unknown>[], columns: DatasetColumn[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const newRow: Record<string, unknown> = {}
    columns.forEach((col) => {
      newRow[col.id] = row[col.name]
    })
    return newRow
  })
}

function getUniqueName(name: string, parentId: string | null, files: DatasetFile[]): string {
  const siblings = files.filter((f) => f.parentId === parentId && f.type === 'file')
  const existingNames = new Set(siblings.map((f) => f.name))
  if (!existingNames.has(name)) return name
  const base = name.replace(/\.[^.]+$/, '')
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  let i = 2
  while (existingNames.has(`${base} (${i})${ext}`)) i++
  return `${base} (${i})${ext}`
}

export function UploadDatasetDialog({ open, onOpenChange, parentId }: UploadDatasetDialogProps) {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedData | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Parse options
  const [delimiter, setDelimiter] = useState<Delimiter>('auto')
  const [skipRows, setSkipRows] = useState(0)
  const [encoding, setEncoding] = useState<Encoding>('UTF-8')
  const [hasHeader, setHasHeader] = useState(true)

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setFile(null)
      setParsed(null)
      setError(null)
      setLoading(false)
      setDelimiter('auto')
      setSkipRows(0)
      setEncoding('UTF-8')
      setHasHeader(true)
    }
  }, [open])

  // Re-parse when options change (if file is set)
  useEffect(() => {
    if (file && !loading) {
      parseFile(file)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delimiter, skipRows, encoding, hasHeader])

  const isCSVLike = useCallback((f: File) => {
    const ext = f.name.toLowerCase()
    return ext.endsWith('.csv') || ext.endsWith('.tsv') || ext.endsWith('.txt') || f.type === 'text/csv'
  }, [])

  const isExcel = useCallback((f: File) => {
    const ext = f.name.toLowerCase()
    return ext.endsWith('.xlsx') || ext.endsWith('.xls')
  }, [])

  const isParquet = useCallback((f: File) => {
    return f.name.toLowerCase().endsWith('.parquet')
  }, [])

  const parseFile = useCallback((f: File) => {
    setLoading(true)
    setError(null)

    if (isCSVLike(f)) {
      parseCSV(f)
    } else if (isExcel(f)) {
      parseExcel(f)
    } else if (isParquet(f)) {
      parseParquet(f)
    } else {
      setError(t('datasets.upload_unsupported_format'))
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delimiter, skipRows, encoding, hasHeader, isCSVLike, isExcel, isParquet, t])

  const parseCSV = useCallback((f: File) => {
    const papaConfig: Papa.ParseLocalConfig<Record<string, unknown>, File> = {
      header: hasHeader,
      skipEmptyLines: true,
      dynamicTyping: true,
      encoding,
      complete: (result: Papa.ParseResult<Record<string, unknown>>) => {
        try {
          let dataRows = result.data as Record<string, unknown>[]

          // Skip rows
          if (skipRows > 0) {
            dataRows = dataRows.slice(skipRows)
          }

          const headers = hasHeader
            ? (result.meta.fields ?? [])
            : Object.keys(dataRows[0] || {})

          if (headers.length === 0) {
            setError(t('datasets.upload_no_columns'))
            setLoading(false)
            return
          }

          const columns = buildColumns(headers, dataRows)
          const remapped = remapRows(dataRows, columns)

          setParsed({
            fileName: f.name,
            columns,
            rows: remapped,
            preview: remapped.slice(0, 10),
            totalRows: remapped.length,
          })
        } catch {
          setError(t('datasets.upload_parse_error'))
        }
        setLoading(false)
      },
      error: () => {
        setError(t('datasets.upload_parse_error'))
        setLoading(false)
      },
    }

    if (delimiter !== 'auto') {
      papaConfig.delimiter = delimiter
    }

    Papa.parse(f, papaConfig)
  }, [delimiter, skipRows, encoding, hasHeader, t])

  const parseExcel = useCallback((f: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const sheetName = wb.SheetNames[0]
        if (!sheetName) {
          setError(t('datasets.upload_no_columns'))
          setLoading(false)
          return
        }
        const ws = wb.Sheets[sheetName]
        let jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
          header: hasHeader ? undefined : 1,
          defval: null,
        })

        if (skipRows > 0) {
          jsonData = jsonData.slice(skipRows)
        }

        const headers = Object.keys(jsonData[0] || {}).map(String)
        if (headers.length === 0) {
          setError(t('datasets.upload_no_columns'))
          setLoading(false)
          return
        }

        const columns = buildColumns(headers, jsonData)
        const remapped = remapRows(jsonData, columns)

        setParsed({
          fileName: f.name,
          columns,
          rows: remapped,
          preview: remapped.slice(0, 10),
          totalRows: remapped.length,
        })
      } catch {
        setError(t('datasets.upload_parse_error'))
      }
      setLoading(false)
    }
    reader.onerror = () => {
      setError(t('datasets.upload_parse_error'))
      setLoading(false)
    }
    reader.readAsArrayBuffer(f)
  }, [skipRows, hasHeader, t])

  const parseParquet = useCallback(async (f: File) => {
    try {
      // Use DuckDB to read Parquet files
      const { getDuckDB } = await import('@/lib/duckdb/engine')
      const db = await getDuckDB()
      const conn = await db.connect()

      // Register the file in DuckDB
      const buffer = await f.arrayBuffer()
      await db.registerFileBuffer(f.name, new Uint8Array(buffer))

      const result = await conn.query(`SELECT * FROM read_parquet('${f.name}')`)
      const rows = result.toArray().map((row: Record<string, unknown>) => {
        const obj: Record<string, unknown> = {}
        for (const key of Object.keys(row)) {
          obj[key] = row[key]
        }
        return obj
      })

      const headers = result.schema.fields.map((f: { name: string }) => f.name)
      const columns = buildColumns(headers, rows)
      const remapped = remapRows(rows, columns)

      await conn.close()

      setParsed({
        fileName: f.name,
        columns,
        rows: remapped,
        preview: remapped.slice(0, 10),
        totalRows: remapped.length,
      })
    } catch {
      setError(t('datasets.upload_parse_error'))
    }
    setLoading(false)
  }, [t])

  const handleFile = useCallback(
    (f: File) => {
      setFile(f)
      setParsed(null)
      setError(null)
      parseFile(f)
    },
    [parseFile],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const f = e.dataTransfer.files[0]
      if (f) handleFile(f)
    },
    [handleFile],
  )

  // Check for duplicate filename when file is parsed
  const { files: storeFiles } = useDatasetStore()
  const existingFile = useMemo(() => {
    if (!parsed) return null
    return storeFiles.find(
      (f) => f.name === parsed.fileName && f.parentId === parentId && f.type === 'file'
    ) ?? null
  }, [parsed, parentId, storeFiles])

  const doImport = useCallback(async (mode: 'new' | 'overwrite' | 'copy') => {
    if (!parsed || !file) return
    const store = useDatasetStore.getState()

    // Build parse options to persist
    const opts: DatasetParseOptions = {}
    if (delimiter !== 'auto') opts.delimiter = delimiter
    if (encoding !== 'UTF-8') opts.encoding = encoding
    if (skipRows > 0) opts.skipRows = skipRows
    if (!hasHeader) opts.hasHeader = false
    const parseOpts = Object.keys(opts).length > 0 ? opts : undefined

    // Build raw file blob for re-import support
    const rawFile = { blob: file, fileName: file.name }

    // Close dialog immediately to avoid re-render showing conflict banner
    onOpenChange(false)

    if (mode === 'overwrite' && existingFile) {
      // Sequential IDB writes via reimportData (awaited)
      await store.reimportData(existingFile.id, parsed.columns, parsed.rows, parseOpts)
      store.openFile(existingFile.id)
      store.selectFile(existingFile.id)
      // Save raw file for re-import
      const { getStorage } = await import('@/lib/storage')
      await getStorage().datasetRawFiles.save({ datasetFileId: existingFile.id, ...rawFile })
    } else {
      const fileName = mode === 'copy'
        ? getUniqueName(parsed.fileName, parentId, store.files)
        : parsed.fileName
      // Single atomic method — no race conditions
      await store.createFileWithData(fileName, parentId, parsed.columns, parsed.rows, parseOpts, rawFile)
    }
  }, [parsed, file, parentId, onOpenChange, existingFile, delimiter, encoding, skipRows, hasHeader])

  const handleImport = useCallback(() => {
    if (!parsed) return
    if (existingFile) return // conflict — buttons handle it
    doImport('new')
  }, [parsed, existingFile, doImport])

  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleClearFile = useCallback(() => {
    setFile(null)
    setParsed(null)
    setError(null)
  }, [])

  const showCSVOptions = file && isCSVLike(file)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('datasets.upload_dataset')}</DialogTitle>
          <DialogDescription>{t('datasets.upload_description')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {/* Drop zone or file info */}
          {!file ? (
            <div
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
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
              <p className="mt-2 text-[10px] text-muted-foreground">CSV, TSV, Excel (.xlsx, .xls), Parquet</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xls,.parquet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                  e.target.value = ''
                }}
              />
            </div>
          ) : (
            <>
              {/* File info bar */}
              <div className="flex items-center gap-2 rounded-md border p-2">
                <FileSpreadsheet size={16} className="text-emerald-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  {parsed && (
                    <p className="text-[10px] text-muted-foreground">
                      {parsed.totalRows.toLocaleString()} {t('datasets.rows')} · {parsed.columns.length} {t('datasets.columns')}
                    </p>
                  )}
                </div>
                <Button variant="ghost" size="icon-xs" onClick={handleClearFile}>
                  <X size={14} />
                </Button>
              </div>

              {/* Parse options (CSV/TSV only) */}
              {showCSVOptions && (
                <div className="grid grid-cols-4 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('datasets.upload_delimiter')}</Label>
                    <Select value={delimiter} onValueChange={(v) => setDelimiter(v as Delimiter)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t('datasets.upload_delimiter_auto')}</SelectItem>
                        <SelectItem value=",">{t('datasets.upload_delimiter_comma')}</SelectItem>
                        <SelectItem value="	">{t('datasets.upload_delimiter_tab')}</SelectItem>
                        <SelectItem value=";">{t('datasets.upload_delimiter_semicolon')}</SelectItem>
                        <SelectItem value="|">{t('datasets.upload_delimiter_pipe')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('datasets.upload_encoding')}</Label>
                    <Select value={encoding} onValueChange={(v) => setEncoding(v as Encoding)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="UTF-8">UTF-8</SelectItem>
                        <SelectItem value="ISO-8859-1">ISO-8859-1 (Latin-1)</SelectItem>
                        <SelectItem value="Windows-1252">Windows-1252</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('datasets.upload_skip_rows')}</Label>
                    <Input
                      type="number"
                      min={0}
                      value={skipRows}
                      onChange={(e) => setSkipRows(Math.max(0, parseInt(e.target.value) || 0))}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('datasets.upload_header')}</Label>
                    <Select value={hasHeader ? 'yes' : 'no'} onValueChange={(v) => setHasHeader(v === 'yes')}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="yes">{t('datasets.upload_header_yes')}</SelectItem>
                        <SelectItem value="no">{t('datasets.upload_header_no')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm text-destructive">
                  <AlertCircle size={14} className="shrink-0" />
                  {error}
                </div>
              )}

              {/* Loading */}
              {loading && (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              )}

              {/* Preview table */}
              {parsed && !loading && (
                <div className="flex-1 min-h-0 overflow-auto rounded border">
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-muted z-10">
                      <tr>
                        <th className="border-b border-r px-2 py-1.5 text-center font-medium text-muted-foreground w-10">#</th>
                        {parsed.columns.map((col) => (
                          <th key={col.id} className="border-b px-2 py-1.5 text-left font-medium whitespace-nowrap">
                            {col.name}
                            <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">{col.type}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.preview.map((row, i) => (
                        <tr key={i} className="hover:bg-muted/50">
                          <td className="border-b border-r px-2 py-1 text-center text-muted-foreground tabular-nums">{i + 1}</td>
                          {parsed.columns.map((col) => (
                            <td key={col.id} className="border-b px-2 py-1 whitespace-nowrap max-w-[200px] truncate">
                              {row[col.id] != null ? String(row[col.id]) : <span className="italic text-muted-foreground">null</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsed.totalRows > 10 && (
                    <div className="border-t px-2 py-1 text-[10px] text-muted-foreground bg-muted/50">
                      {t('datasets.upload_preview_hint', { shown: 10, total: parsed.totalRows.toLocaleString() })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Duplicate file conflict banner */}
        {parsed && existingFile && !loading && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2.5 text-sm">
            <TriangleAlert size={16} className="shrink-0 text-amber-500 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">{t('datasets.upload_conflict_title')}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t('datasets.upload_conflict_description', { name: parsed.fileName })}
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          {parsed && !existingFile && (
            <Button onClick={handleImport} size="default">
              {t('datasets.import')} ({parsed.totalRows.toLocaleString()} {t('datasets.rows')})
            </Button>
          )}
          {parsed && existingFile && (
            <>
              <Button variant="outline" onClick={() => doImport('copy')} size="default">
                {t('datasets.upload_import_copy')}
              </Button>
              <Button onClick={() => doImport('overwrite')} size="default">
                {t('datasets.upload_overwrite')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
