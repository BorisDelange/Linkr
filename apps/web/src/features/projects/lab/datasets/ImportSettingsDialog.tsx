import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FileSpreadsheet, AlertCircle } from 'lucide-react'
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
import { getStorage } from '@/lib/storage'
import type { DatasetColumn, DatasetFile, DatasetParseOptions } from '@/types'

interface ImportSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: DatasetFile
}

type Delimiter = 'auto' | ',' | '\t' | ';' | '|'
type Encoding = 'UTF-8' | 'ISO-8859-1' | 'Windows-1252'

interface ParsedData {
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  preview: Record<string, unknown>[]
  totalRows: number
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

export function ImportSettingsDialog({ open, onOpenChange, file }: ImportSettingsDialogProps) {
  const { t } = useTranslation()
  const [rawBlob, setRawBlob] = useState<Blob | null>(null)
  const [rawFileName, setRawFileName] = useState('')
  const [loadingRaw, setLoadingRaw] = useState(true)
  const [parsed, setParsed] = useState<ParsedData | null>(null)
  const [loading, setLoading] = useState(false)
  const [reimporting, setReimporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Parse options — initialized from file's current options
  const [delimiter, setDelimiter] = useState<Delimiter>('auto')
  const [skipRows, setSkipRows] = useState(0)
  const [encoding, setEncoding] = useState<Encoding>('UTF-8')
  const [hasHeader, setHasHeader] = useState(true)

  // Load raw file and initialize options when dialog opens
  useEffect(() => {
    if (!open) return
    setLoadingRaw(true)
    setError(null)
    setParsed(null)

    // Initialize from saved parse options
    const opts = file.parseOptions
    setDelimiter((opts?.delimiter as Delimiter) ?? 'auto')
    setSkipRows(opts?.skipRows ?? 0)
    setEncoding((opts?.encoding as Encoding) ?? 'UTF-8')
    setHasHeader(opts?.hasHeader !== false)

    getStorage().datasetRawFiles.get(file.id).then((raw) => {
      if (raw) {
        setRawBlob(raw.blob)
        setRawFileName(raw.fileName)
      } else {
        setRawBlob(null)
        setRawFileName('')
      }
      setLoadingRaw(false)
    }).catch(() => {
      setRawBlob(null)
      setLoadingRaw(false)
    })
  }, [open, file.id, file.parseOptions])

  const isCSVLike = useCallback((name: string) => {
    const ext = name.toLowerCase()
    return ext.endsWith('.csv') || ext.endsWith('.tsv') || ext.endsWith('.txt')
  }, [])

  const isExcel = useCallback((name: string) => {
    const ext = name.toLowerCase()
    return ext.endsWith('.xlsx') || ext.endsWith('.xls')
  }, [])

  const isParquet = useCallback((name: string) => {
    return name.toLowerCase().endsWith('.parquet')
  }, [])

  const showCSVOptions = rawFileName ? isCSVLike(rawFileName) : false

  // Parse the raw blob with current options
  const parseRaw = useCallback(() => {
    if (!rawBlob || !rawFileName) return
    setLoading(true)
    setError(null)

    if (isCSVLike(rawFileName)) {
      const blobAsFile = new File([rawBlob], rawFileName)
      const papaConfig: Papa.ParseLocalConfig<Record<string, unknown>, File> = {
        header: hasHeader,
        skipEmptyLines: true,
        dynamicTyping: true,
        encoding,
        complete: (result: Papa.ParseResult<Record<string, unknown>>) => {
          try {
            let dataRows = result.data as Record<string, unknown>[]
            if (skipRows > 0) dataRows = dataRows.slice(skipRows)
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
      if (delimiter !== 'auto') papaConfig.delimiter = delimiter
      Papa.parse(blobAsFile, papaConfig)
    } else if (isExcel(rawFileName)) {
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
          if (skipRows > 0) jsonData = jsonData.slice(skipRows)
          const headers = Object.keys(jsonData[0] || {}).map(String)
          if (headers.length === 0) {
            setError(t('datasets.upload_no_columns'))
            setLoading(false)
            return
          }
          const columns = buildColumns(headers, jsonData)
          const remapped = remapRows(jsonData, columns)
          setParsed({
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
      reader.readAsArrayBuffer(rawBlob)
    } else if (isParquet(rawFileName)) {
      ;(async () => {
        try {
          const { getDuckDB } = await import('@/lib/duckdb/engine')
          const db = await getDuckDB()
          const conn = await db.connect()
          const buffer = await rawBlob.arrayBuffer()
          await db.registerFileBuffer(rawFileName, new Uint8Array(buffer))
          const result = await conn.query(`SELECT * FROM read_parquet('${rawFileName}')`)
          const rows = result.toArray().map((row: Record<string, unknown>) => {
            const obj: Record<string, unknown> = {}
            for (const key of Object.keys(row)) obj[key] = row[key]
            return obj
          })
          const headers = result.schema.fields.map((f: { name: string }) => f.name)
          const columns = buildColumns(headers, rows)
          const remapped = remapRows(rows, columns)
          await conn.close()
          setParsed({
            columns,
            rows: remapped,
            preview: remapped.slice(0, 10),
            totalRows: remapped.length,
          })
        } catch {
          setError(t('datasets.upload_parse_error'))
        }
        setLoading(false)
      })()
    }
  }, [rawBlob, rawFileName, delimiter, skipRows, encoding, hasHeader, isCSVLike, isExcel, isParquet, t])

  // Auto-parse when raw file is loaded or options change
  useEffect(() => {
    if (rawBlob && rawFileName && !loadingRaw) {
      parseRaw()
    }
  }, [rawBlob, rawFileName, loadingRaw, parseRaw])

  const handleReimport = useCallback(async () => {
    if (!parsed) return
    setReimporting(true)
    const store = useDatasetStore.getState()
    const opts: DatasetParseOptions = {}
    if (delimiter !== 'auto') opts.delimiter = delimiter
    if (encoding !== 'UTF-8') opts.encoding = encoding
    if (skipRows > 0) opts.skipRows = skipRows
    if (!hasHeader) opts.hasHeader = false
    const parseOpts = Object.keys(opts).length > 0 ? opts : undefined

    await store.reimportData(file.id, parsed.columns, parsed.rows, parseOpts)
    setReimporting(false)
    onOpenChange(false)
  }, [parsed, file.id, delimiter, encoding, skipRows, hasHeader, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('datasets.import_settings_title')}</DialogTitle>
          <DialogDescription>{t('datasets.import_settings_description')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {loadingRaw ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : !rawBlob ? (
            <div className="flex items-center gap-2 rounded-md border border-muted p-4 text-sm text-muted-foreground">
              <AlertCircle size={16} className="shrink-0" />
              {t('datasets.import_settings_no_raw')}
            </div>
          ) : (
            <>
              {/* Source file info */}
              <div className="flex items-center gap-2 rounded-md border p-2">
                <FileSpreadsheet size={16} className="text-emerald-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{rawFileName}</p>
                  {parsed && (
                    <p className="text-[10px] text-muted-foreground">
                      {parsed.totalRows.toLocaleString()} {t('datasets.rows')} · {parsed.columns.length} {t('datasets.columns')}
                    </p>
                  )}
                </div>
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

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {rawBlob && parsed && !loading && (
            <Button onClick={handleReimport} disabled={reimporting}>
              {reimporting
                ? t('datasets.import_settings_reimporting')
                : t('datasets.import_settings_apply')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
