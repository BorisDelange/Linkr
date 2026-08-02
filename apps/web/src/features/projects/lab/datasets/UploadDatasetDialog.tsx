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
import { buildColumns } from '@/lib/dataset-utils'
import { isServerMode } from '@/lib/api-client'
import { importDatasetBySha, previewDatasetBySha, previewDatasetOnServer, importDatasetOnServer, setDatasetColumnMeta } from '@/lib/api/datasets'
import { isGoupileWorkbook, parseGoupileWorkbook, type GoupileColumnMeta, type SheetMap } from '@/lib/goupile-import'
import { Checkbox } from '@/components/ui/checkbox'
import { TypeBadge } from './TypeBadge'
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
  /** Goupile import only: per-column-id metadata to push after the dataset is
   *  created (labels/descriptions/valueLabels derived from the export dictionary). */
  goupileMeta?: Record<string, GoupileColumnMeta>
  // Server mode: the blob was uploaded during preview; reuse this sha at import
  // instead of re-uploading. `rows` stays empty in server mode (the server holds
  // the full data), so only `preview` drives the table.
  sha?: string
}

type Delimiter = 'auto' | ',' | '\t' | ';' | '|'
type Encoding = 'UTF-8' | 'ISO-8859-1' | 'Windows-1252'

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
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Server preview: the raw file is uploaded ONCE (per selected file); its sha is
  // cached so option tweaks re-preview by sha instead of re-uploading the whole
  // file each keystroke. previewSeq discards out-of-order preview responses.
  const uploadedShaRef = useRef<{ file: File; sha: string } | null>(null)
  const previewSeqRef = useRef(0)

  // Parse options
  const [delimiter, setDelimiter] = useState<Delimiter>('auto')
  const [skipRows, setSkipRows] = useState(0)
  const [encoding, setEncoding] = useState<Encoding>('UTF-8')
  const [hasHeader, setHasHeader] = useState(true)

  // Excel-specific options
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState<string>('')

  // Goupile eCRF import: detected when the workbook carries @definitions +
  // @propositions. When on, all form sheets are joined on __tid into one wide
  // dataset labelled from the dictionary (see lib/goupile-import.ts).
  const [goupileDetected, setGoupileDetected] = useState(false)
  const [goupileMode, setGoupileMode] = useState(true)

  useEffect(() => {
    if (!open) {
      setFile(null)
      setParsed(null)
      setError(null)
      setLoading(false)
      setImporting(false)
      setDelimiter('auto')
      setSkipRows(0)
      setEncoding('UTF-8')
      setHasHeader(true)
      setSheetNames([])
      setSelectedSheet('')
      setGoupileDetected(false)
      setGoupileMode(true)
      uploadedShaRef.current = null
      previewSeqRef.current++
    }
  }, [open])

  // Re-parse when options change (if file is set). goupileMode re-routes between the
  // joined import and the normal single-sheet import.
  useEffect(() => {
    if (file && !loading) {
      parseFile(file)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delimiter, skipRows, encoding, hasHeader, selectedSheet, goupileMode])

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

  const buildParseOptions = useCallback((): DatasetParseOptions | undefined => {
    const opts: DatasetParseOptions = {}
    if (delimiter !== 'auto') opts.delimiter = delimiter
    if (encoding !== 'UTF-8') opts.encoding = encoding
    if (skipRows > 0) opts.skipRows = skipRows
    if (!hasHeader) opts.hasHeader = false
    if (selectedSheet) opts.sheet = selectedSheet
    return Object.keys(opts).length > 0 ? opts : undefined
  }, [delimiter, encoding, skipRows, hasHeader, selectedSheet])

  // Server mode: no browser parse at all — the server (DuckDB) parses the file
  // and returns columns/types/rowCount/preview (+ Excel sheet names), so what the
  // user previews is exactly what gets imported. The blob is uploaded once here
  // and its sha reused at import time.
  const parseServer = useCallback(async (f: File) => {
    const seq = ++previewSeqRef.current
    try {
      const projectUid = useDatasetStore.getState().activeProjectUid ?? ''
      // Upload the raw file only the FIRST time this file is previewed; every
      // later option tweak re-previews by the cached sha (no full re-upload).
      const cached = uploadedShaRef.current
      const res = cached && cached.file === f
        ? await previewDatasetBySha({ projectUid, sha: cached.sha, fileName: f.name, parseOptions: buildParseOptions() })
        : await previewDatasetOnServer({ projectUid, file: f, fileName: f.name, parseOptions: buildParseOptions() })
      uploadedShaRef.current = { file: f, sha: res.sha }
      // Drop a stale response (a newer option change already fired, or the dialog
      // closed / a different file was picked) so it can't overwrite fresher state.
      if (seq !== previewSeqRef.current) return
      if (res.sheetNames && res.sheetNames.length > 0) {
        setSheetNames(res.sheetNames)
        if (!selectedSheet) setSelectedSheet(res.sheetNames[0])
      }
      if (res.columns.length === 0) {
        setError(t('datasets.upload_no_columns'))
        setLoading(false)
        return
      }
      setParsed({
        fileName: f.name,
        columns: res.columns as DatasetColumn[],
        rows: [],
        preview: res.preview.slice(0, 10),
        totalRows: res.rowCount,
        sha: res.sha,
      })
    } catch (e) {
      if (seq !== previewSeqRef.current) return
      setError(e instanceof Error ? e.message : t('datasets.upload_parse_error'))
    }
    if (seq === previewSeqRef.current) setLoading(false)
  }, [buildParseOptions, selectedSheet, t])

  const parseFile = useCallback((f: File) => {
    setLoading(true)
    setError(null)
    setWarning(null)

    const supported = isCSVLike(f) || isExcel(f) || isParquet(f)
    if (!supported) {
      setError(t('datasets.upload_unsupported_format'))
      setLoading(false)
      return
    }

    // A detected Goupile export in Goupile mode is joined client-side (both server
    // and local modes) into one wide CSV, regardless of the normal parse path.
    if (isExcel(f) && goupileDetected && goupileMode) {
      parseGoupile(f)
      return
    }

    // In server mode every supported format is parsed server-side; the browser
    // parsers (papaparse/xlsx/DuckDB-WASM) exist only for local (WASM) mode.
    if (isServerMode()) {
      parseServer(f)
    } else if (isCSVLike(f)) {
      parseCSV(f)
    } else if (isExcel(f)) {
      parseExcel(f)
    } else {
      parseParquet(f)
    }
    // parseGoupile/parseCSV/parseExcel/parseParquet are declared below; the
    // disable keeps them out of deps (they're stable useCallbacks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delimiter, skipRows, encoding, hasHeader, selectedSheet, goupileDetected, goupileMode, isCSVLike, isExcel, isParquet, parseServer, t])

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

  // Goupile eCRF: join all form sheets on __tid into one wide dataset labelled from
  // the export's dictionary. Produces a flat joined CSV that becomes the dataset's
  // raw file (so a later re-parse is stable — the join is done once, here).
  const goupileCsvRef = useRef<File | null>(null)
  const parseGoupile = useCallback((f: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target?.result as ArrayBuffer), { type: 'array' })
        const sheets: SheetMap = {}
        for (const sn of wb.SheetNames) {
          sheets[sn] = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sn], { defval: null })
        }
        const { columns: colNames, rows, columnMeta, duplicateForms } = parseGoupileWorkbook(sheets, {
          __tid: { label: t('datasets.goupile_col_tid'), description: t('datasets.goupile_col_tid_desc') },
          __sequence: { label: t('datasets.goupile_col_sequence'), description: t('datasets.goupile_col_sequence_desc') },
          __hid: { label: t('datasets.goupile_col_hid'), description: t('datasets.goupile_col_hid_desc') },
        })
        if (colNames.length === 0 || rows.length === 0) {
          setError(t('datasets.upload_no_columns'))
          setLoading(false)
          return
        }
        setWarning(
          duplicateForms.length > 0
            ? t('datasets.goupile_duplicate_rows', { forms: duplicateForms.join(', ') })
            : null,
        )
        const columns = buildColumns(colNames, rows)
        const remapped = remapRows(rows, columns)
        // Metadata keyed by columnId (the id the dataset stores), from name-keyed meta.
        const metaById: Record<string, GoupileColumnMeta> = {}
        for (const col of columns) {
          const m = columnMeta[col.name]
          if (m && (m.label || m.description || m.valueLabels)) metaById[col.id] = m
        }
        // The joined CSV becomes the raw file (headers = column NAMES, so a re-parse
        // rebuilds the same column ids).
        const csv = Papa.unparse({ fields: colNames, data: rows.map((r) => colNames.map((c) => r[c] ?? '')) })
        const base = f.name.replace(/\.[^.]+$/, '')
        goupileCsvRef.current = new File([csv], `${base}.csv`, { type: 'text/csv' })

        setParsed({
          fileName: `${base}.csv`,
          columns,
          rows: remapped,
          preview: remapped.slice(0, 10),
          totalRows: remapped.length,
          goupileMeta: metaById,
        })
      } catch {
        setError(t('datasets.upload_parse_error'))
      }
      setLoading(false)
    }
    reader.onerror = () => { setError(t('datasets.upload_parse_error')); setLoading(false) }
    reader.readAsArrayBuffer(f)
  }, [t])

  const parseExcel = useCallback((f: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })

        // Populate sheet list and auto-select first sheet if none chosen
        setSheetNames(wb.SheetNames)
        const sheetName = selectedSheet && wb.SheetNames.includes(selectedSheet)
          ? selectedSheet
          : wb.SheetNames[0]
        if (!selectedSheet && sheetName) setSelectedSheet(sheetName)

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
  }, [skipRows, hasHeader, selectedSheet, t])

  // Local (WASM) mode only — server mode parses Parquet via parseServer.
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
      // Sniff an Excel workbook's sheet names client-side (both modes) to detect a
      // Goupile export before choosing the parse path; parseGoupile handles it when on.
      if (isExcel(f)) {
        setLoading(true)
        const reader = new FileReader()
        reader.onload = (e) => {
          let detected = false
          try {
            const wb = XLSX.read(new Uint8Array(e.target?.result as ArrayBuffer), { type: 'array', bookSheets: true })
            detected = isGoupileWorkbook(wb.SheetNames)
          } catch { /* fall through to the normal parse */ }
          setGoupileDetected(detected)
          if (detected && goupileMode) parseGoupile(f)
          else parseFile(f)
        }
        reader.onerror = () => parseFile(f)
        reader.readAsArrayBuffer(f)
        return
      }
      parseFile(f)
    },
    [parseFile, parseGoupile, isExcel, goupileMode],
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

    // Goupile import: create the dataset from the joined CSV, then apply the
    // dictionary-derived labels. Overwrite/copy fall back to a plain 'new' here —
    // a joined import always creates a fresh dataset.
    if (parsed.goupileMeta && goupileCsvRef.current) {
      const projectUid = store.activeProjectUid ?? ''
      const csvFile = goupileCsvRef.current
      const name = getUniqueName(parsed.fileName, parentId, store.files)
      setImporting(true)
      setError(null)
      try {
        let path: string
        if (isServerMode()) {
          const created = await importDatasetOnServer({ projectUid, name, parentId, file: csvFile, fileName: name })
          path = created.id
          // Push the dictionary labels, then insert the RE-MERGED node (the import
          // node predates the metadata, so inserting `created` would show no labels).
          const labelled = await setDatasetColumnMeta({ projectUid, path, columns: parsed.goupileMeta })
          store.addImportedFile(labelled)
        } else {
          const fileId = await store.createFileWithData(
            name, parentId, parsed.columns, parsed.rows, undefined,
            { blob: csvFile, fileName: name },
          )
          // Local mode persists column meta inline via the store.
          for (const [colId, meta] of Object.entries(parsed.goupileMeta)) {
            store.updateColumnMeta(fileId, colId, meta)
          }
        }
        onOpenChange(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('datasets.upload_parse_error'))
      } finally {
        setImporting(false)
      }
      return
    }

    const parseOpts = buildParseOptions()

    const rawFile = { blob: file, fileName: file.name }

    // Server mode: the blob was already uploaded during the server preview — land
    // it by its sha (no re-upload) and parse it with the SAME options the preview
    // used, so what was previewed is exactly what gets imported. Keep the dialog
    // open until success so any error is shown in place.
    if (isServerMode()) {
      const projectUid = store.activeProjectUid ?? ''
      const name =
        mode === 'copy'
          ? getUniqueName(parsed.fileName, parentId, store.files)
          : parsed.fileName
      setImporting(true)
      setError(null)
      try {
        if (mode === 'overwrite' && existingFile) {
          const { getStorage } = await import('@/lib/storage')
          await getStorage().datasetFiles.delete(existingFile.id)
          store.deleteNode(existingFile.id)
        }
        if (!parsed.sha) throw new Error(t('datasets.upload_parse_error'))
        const created = await importDatasetBySha({
          projectUid,
          name,
          parentId,
          sha: parsed.sha,
          fileName: name,
          parseOptions: parseOpts,
        })
        store.addImportedFile(created)
        onOpenChange(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('datasets.upload_parse_error'))
      } finally {
        setImporting(false)
      }
      return
    }

    // Local (client-only) mode: persist to IndexedDB. Keep the dialog open on
    // error so an IDB write failure is shown rather than lost silently.
    setImporting(true)
    setError(null)
    try {
      if (mode === 'overwrite' && existingFile) {
        // Sequential IDB writes via reimportData (awaited)
        await store.reimportData(existingFile.id, parsed.columns, parsed.rows, parseOpts)
        store.openFile(existingFile.id)
        store.selectFile(existingFile.id)
        const { getStorage } = await import('@/lib/storage')
        await getStorage().datasetRawFiles.save({ datasetFileId: existingFile.id, ...rawFile })
      } else {
        const fileName = mode === 'copy'
          ? getUniqueName(parsed.fileName, parentId, store.files)
          : parsed.fileName
        // Single atomic method — no race conditions
        await store.createFileWithData(fileName, parentId, parsed.columns, parsed.rows, parseOpts, rawFile)
      }
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('datasets.upload_parse_error'))
    } finally {
      setImporting(false)
    }
  }, [parsed, file, parentId, onOpenChange, existingFile, buildParseOptions, t])
  // (Goupile branch uses parentId/onOpenChange/t + refs — same closure deps.)

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
  const showExcelOptions = file && isExcel(file)

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
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer ${
                dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              <Upload size={32} className="text-muted-foreground/50" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('datasets.drag_drop_or')}
              </p>
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

              {/* Goupile eCRF detected — offer the joined, labelled import. */}
              {goupileDetected && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 space-y-1.5">
                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    {t('datasets.goupile_detected')}
                  </p>
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <Checkbox
                      checked={goupileMode}
                      onCheckedChange={(v) => setGoupileMode(v === true)}
                      className="mt-0.5"
                    />
                    <span className="text-muted-foreground">{t('datasets.goupile_join_hint')}</span>
                  </label>
                </div>
              )}

              {/* Parse options (CSV/TSV) */}
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

              {/* Parse options (Excel) */}
              {showExcelOptions && (
                <div className="grid grid-cols-3 gap-3">
                  {sheetNames.length > 1 && (
                    <div className="space-y-1">
                      <Label className="text-xs">{t('datasets.upload_sheet')}</Label>
                      <Select value={selectedSheet} onValueChange={setSelectedSheet}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {sheetNames.map((name) => (
                            <SelectItem key={name} value={name}>{name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
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

              {/* Warning (non-blocking, e.g. a repeatable form dropped extra rows) */}
              {warning && (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertCircle size={14} className="shrink-0" />
                  {warning}
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
                            <span className="inline-flex items-center gap-1.5">
                              {col.name}
                              <TypeBadge type={col.type} size="sm" />
                            </span>
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
          <Button variant="outline" onClick={handleClose} disabled={importing}>
            {t('common.cancel')}
          </Button>
          {parsed && !existingFile && (
            <Button onClick={handleImport} size="default" disabled={importing}>
              {importing && <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {t('datasets.import')} ({parsed.totalRows.toLocaleString()} {t('datasets.rows')})
            </Button>
          )}
          {parsed && existingFile && (
            <>
              <Button variant="outline" onClick={() => doImport('copy')} size="default" disabled={importing}>
                {t('datasets.upload_import_copy')}
              </Button>
              <Button onClick={() => doImport('overwrite')} size="default" disabled={importing}>
                {t('datasets.upload_overwrite')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
