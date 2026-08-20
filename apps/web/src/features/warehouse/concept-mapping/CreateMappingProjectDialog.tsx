import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { Upload, FileSpreadsheet, AlertCircle, X, Database, FileUp, Settings2, ArrowLeft, Check, Plus, Info, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
// Note: Popover is still used for the extra-columns multi-select below
import { Badge } from '@/components/ui/badge'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { VersionField } from '@/components/ui/version-field'
import { localized, setLocalized } from '@/lib/localized'
import { useSaveForm } from '@/hooks/use-save-form'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { SectionLabel } from '@/components/ui/section-label'
import { isServerMode } from '@/lib/api-client'
import { previewFileColumnsOnServer } from '@/lib/api/mapping-projects'
import type { MappingProject, MappingProjectSourceType, FileColumnMapping, FileSourceData, MappingProjectStatus, ProjectBadge, BadgeColor } from '@/types'

interface CreateMappingProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (projectId: string) => void
  editingProject?: MappingProject | null
}

type Delimiter = 'auto' | ',' | '\t' | ';' | '|'
type Encoding = 'UTF-8' | 'ISO-8859-1' | 'Windows-1252'

// Rows parsed client-side purely to render the modal preview + detect columns.
// The full file is read server-side (or WASM) at query time, never here.
const PREVIEW_ROWS = 20

export const MAPPING_STATUS_COLORS: Record<import('@/types').MappingProjectStatus, { bg: string; text: string; dot: string }> = {
  in_progress: { bg: 'bg-blue-100 dark:bg-blue-950',     text: 'text-blue-700 dark:text-blue-300',     dot: 'bg-blue-500' },
  on_hold:     { bg: 'bg-amber-100 dark:bg-amber-950',   text: 'text-amber-700 dark:text-amber-300',   dot: 'bg-amber-500' },
  completed:   { bg: 'bg-emerald-100 dark:bg-emerald-950', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
}

/** Known concept field roles for column mapping, grouped for layout. */
const COLUMN_ROLE_ROWS: (readonly (keyof FileColumnMapping)[])[] = [
  ['terminologyColumn', 'conceptCodeColumn'],
  ['conceptNameColumn', 'conceptIdColumn'],
  ['categoryColumn'],
  ['recordCountColumn', 'patientCountColumn'],
  ['infoJsonColumn'],
] as const

export function CreateMappingProjectDialog({
  open,
  onOpenChange,
  onCreated,
  editingProject,
}: CreateMappingProjectDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { activeWorkspaceId } = useWorkspaceStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { createMappingProject, updateMappingProject, reconcileMappingsToFile } = useConceptMappingStore()

  // --- Common fields ---
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<MappingProjectStatus>('in_progress')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})
  const [sourceType, setSourceType] = useState<MappingProjectSourceType>('file')

  // --- Database source ---
  const [dataSourceId, setDataSourceId] = useState('')

  // --- File source ---
  const [file, setFile] = useState<File | null>(null)
  const [rawFileBuffer, setRawFileBuffer] = useState<Uint8Array | null>(null)
  // Set when a file was uploaded during preview (server-mode Parquet) so create
  // reuses the blob instead of re-uploading it.
  const [preUploadedSha, setPreUploadedSha] = useState<string | null>(null)
  const [parsedColumns, setParsedColumns] = useState<string[]>([])
  const [parsedRows, setParsedRows] = useState<Record<string, unknown>[]>([])
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([])
  const [totalRows, setTotalRows] = useState(0)
  // Duplicate source concepts (same vocab+code) in a freshly-picked CSV (WASM) —
  // drives the inline file-summary note.
  const [duplicatesRemoved, setDuplicatesRemoved] = useState(0)
  // After create/import: how many duplicates the source view will drop. When > 0
  // we show a one-time modal and defer closing the dialog until it's dismissed.
  const [importDuplicates, setImportDuplicates] = useState<number | null>(null)
  const pendingCloseRef = useRef<(() => void) | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // File parse options
  const [delimiter, setDelimiter] = useState<Delimiter>('auto')
  const [skipRows, setSkipRows] = useState(0)
  const [encoding, setEncoding] = useState<Encoding>('UTF-8')
  const [hasHeader, setHasHeader] = useState(true)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState<string>('')

  // Column mapping
  const [columnMapping, setColumnMapping] = useState<FileColumnMapping>({})

  // Two-page modal: 'main' | 'import-settings'
  const [page, setPage] = useState<'main' | 'import-settings'>('main')
  const [mainTab, setMainTab] = useState<'info' | 'source'>('info')

  const isEdit = !!editingProject
  const { mappingProjects } = useConceptMappingStore()
  const existingIds = mappingProjects.map(p => p.entityId).filter((id): id is string => !!id)

  /** Badges already attached to the current project, indexed by label (case-insensitive). */
  const currentBadgeLabels = useMemo(
    () => new Set(badges.map((b) => localized(b.label, language).toLowerCase())),
    [badges, language],
  )

  /** Suggestions = distinct badges from other workspace mapping projects (excluding the current one).
   *  When the same label appears with different colors across projects, we keep the first-seen color. */
  const badgeSuggestions = useMemo<ProjectBadge[]>(() => {
    if (!activeWorkspaceId) return []
    const seen = new Map<string, ProjectBadge>()
    for (const p of mappingProjects) {
      if (p.workspaceId !== activeWorkspaceId) continue
      if (editingProject && p.id === editingProject.id) continue
      for (const b of p.badges ?? []) {
        const resolved = localized(b.label, language)
        if (!resolved) continue
        const key = resolved.toLowerCase()
        if (!seen.has(key)) seen.set(key, b)
      }
    }
    return [...seen.values()].sort((a, b) => localized(a.label, language).localeCompare(localized(b.label, language)))
  }, [mappingProjects, activeWorkspaceId, editingProject, language])

  /** Set of badge labels (case-insensitive) used in any other project of this workspace. */
  const otherProjectBadgeLabels = useMemo(
    () => new Set(badgeSuggestions.map((b) => localized(b.label, language).toLowerCase())),
    [badgeSuggestions, language],
  )

  /** Reasons we may forbid creating a new badge with this label. */
  type DuplicateKind = 'current' | 'other-project' | null
  const labelConflict = (label: string): DuplicateKind => {
    const k = label.trim().toLowerCase()
    if (!k) return null
    if (currentBadgeLabels.has(k)) return 'current'
    if (otherProjectBadgeLabels.has(k)) return 'other-project'
    return null
  }

  /** Add a badge if its label isn't already attached to the current project. No-op otherwise.
   *  Note: callers should pre-check against other-project conflicts; this function only blocks
   *  same-project duplicates so suggestion clicks (which reuse an existing badge) still work. */
  const addBadge = (badge: ProjectBadge) => {
    const trimmed = localized(badge.label, language).trim()
    if (!trimmed || currentBadgeLabels.has(trimmed.toLowerCase())) return
    setBadges([...badges, { ...badge, id: `b-${Date.now()}`, label: setLocalized(badge.label, language, trimmed) }])
    setNewBadgeLabel('')
  }

  useEffect(() => {
    if (editingProject) {
      setName(localized(editingProject.name, language))
      setEntityId(editingProject.entityId ?? '')
      setDescription(localized(editingProject.description, language))
      setStatus(editingProject.status ?? 'in_progress')
      setBadges(editingProject.badges ?? [])
      setVersion(editingProject.version ?? '0.1.0')
      setSourceType(editingProject.sourceType ?? 'database')
      setDataSourceId(editingProject.dataSourceId ?? '')
      if (editingProject.fileSourceData?.columnMapping) {
        setColumnMapping(editingProject.fileSourceData.columnMapping)
      }
      setAuthoring({})
      setMainTab('info')
    } else if (open) {
      setName('')
      setEntityId('')
      setDescription('')
      setStatus('in_progress')
      setBadges([])
      setVersion('0.1.0')
      setNewBadgeLabel('')
      setNewBadgeColor('blue')
      setSourceType('file')
      setDataSourceId('')
      setFile(null)
      setParsedColumns([])
      setParsedRows([])
      setPreviewRows([])
      setTotalRows(0)
      setFileError(null)
      setFileLoading(false)
      setDelimiter('auto')
      setSkipRows(0)
      setEncoding('UTF-8')
      setHasHeader(true)
      setSheetNames([])
      setSelectedSheet('')
      setColumnMapping({})
      setPage('main')
      setAuthoring({})
      setMainTab('info')
    }
  }, [editingProject, open, language])

  // Focus the name input on open. autoFocus is unreliable inside a Radix
  // Dialog + Tabs (the tab/focus-trap steals it), so focus imperatively.
  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => nameInputRef.current?.focus(), 50)
    return () => clearTimeout(id)
  }, [open])

  const connectedDatabases = dataSources.filter(
    (ds) => ds.sourceType === 'database' && ds.status === 'connected' && !ds.isVocabularyReference,
  )

  // --- File parsing ---
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

  const applyParsedData = useCallback((headers: string[], rows: Record<string, unknown>[]) => {
    setParsedColumns(headers)
    setParsedRows(rows)
    setPreviewRows(rows.slice(0, 10))
    setTotalRows(rows.length)
    setFileError(null)

    // Auto-detect column mapping from header names
    const mapping: FileColumnMapping = {}
    const lowerHeaders = headers.map((h) => h.toLowerCase().replace(/[_\- ]/g, ''))
    headers.forEach((header, i) => {
      const lh = lowerHeaders[i]
      if (!mapping.terminologyColumn && (lh.includes('terminology') || lh.includes('vocabulary') || lh === 'vocabularyid' || lh === 'terminologyid'))
        mapping.terminologyColumn = header
      else if (!mapping.conceptCodeColumn && (lh.includes('conceptcode') || lh === 'code' || lh === 'sourcecode'))
        mapping.conceptCodeColumn = header
      else if (!mapping.conceptIdColumn && (lh.includes('conceptid') || lh === 'id'))
        mapping.conceptIdColumn = header
      else if (!mapping.conceptNameColumn && (lh.includes('conceptname') || lh.includes('label') || lh === 'name' || lh === 'description'))
        mapping.conceptNameColumn = header
      else if (!mapping.recordCountColumn && (lh.includes('recordcount') || lh.includes('records') || lh.includes('rowscount') || lh === 'count' || lh === 'n'))
        mapping.recordCountColumn = header
      else if (!mapping.patientCountColumn && (lh.includes('patientcount') || lh.includes('patients')))
        mapping.patientCountColumn = header
      else if (!mapping.categoryColumn && lh.includes('category'))
        mapping.categoryColumn = header
      else if (!mapping.infoJsonColumn && lh.includes('json'))
        mapping.infoJsonColumn = header
    })
    setColumnMapping(mapping)
  }, [])

  // WASM-mode only: count the rows of a CSV via DuckDB-WASM. In server mode the
  // count comes from the server, so this must never run there.
  const countRowsWasm = useCallback(async (buffer: Uint8Array, _kind: 'csv'): Promise<number> => {
    try {
      const { getDuckDB } = await import('@/lib/duckdb/engine')
      const db = await getDuckDB()
      const conn = await db.connect()
      const tmpName = `__count_${crypto.randomUUID()}.csv`
      await db.registerFileBuffer(tmpName, buffer)
      const res = await conn.query(`SELECT COUNT(*) AS total FROM read_csv_auto('${tmpName}', nullstr='NA')`)
      const total = Number(res.toArray()[0]?.total ?? 0)
      await conn.close()
      return total
    } catch {
      return 0
    }
  }, [])

  // WASM-mode: count duplicate source concepts (same vocabulary_id + concept_code)
  // in a CSV, so the file summary can note them. Best-effort — server mode / Excel
  // fall back to 0 here; the editor's universal check still reports duplicates.
  const countDuplicatesWasm = useCallback(async (
    buffer: Uint8Array, vocabCol: string | undefined, codeCol: string | undefined,
  ): Promise<number> => {
    if (!codeCol) return 0
    const { getDuckDB } = await import('@/lib/duckdb/engine')
    const db = await getDuckDB()
    const tmpName = `__dup_${crypto.randomUUID()}.csv`
    try {
      const conn = await db.connect()
      await db.registerFileBuffer(tmpName, buffer)
      const esc = (s: string) => s.replace(/"/g, '""')
      const keyCols = vocabCol ? `"${esc(vocabCol)}", "${esc(codeCol)}"` : `"${esc(codeCol)}"`
      const res = await conn.query(
        `SELECT COUNT(*) - COUNT(DISTINCT (${keyCols})) AS removed FROM read_csv_auto('${tmpName}', nullstr='NA')`,
      )
      const removed = Number(res.toArray()[0]?.removed ?? 0)
      await conn.close()
      return removed
    } catch {
      return 0
    } finally {
      // Each call registers a full CSV copy under a unique name; drop it or the
      // buffers accumulate for the DB lifetime (the effect below re-runs on every
      // mapping edit). Mirrors scores-engine's dropFile-in-finally.
      try { await db.dropFile(tmpName) } catch { /* not registered / already dropped */ }
    }
  }, [])

  // Count duplicates for a persisted project. Server mode queries the source view
  // via the mapping-projects endpoint (raw minus deduped); WASM uses the CSV
  // buffer directly. Best-effort — returns 0 on any error.
  const countDuplicatesForProject = useCallback(async (
    projectId: string, buffer: Uint8Array | undefined, mapping: FileColumnMapping,
  ): Promise<number> => {
    if (isServerMode()) {
      try {
        const { queryFileSourceOnServer } = await import('@/lib/api/mapping-projects')
        const { buildFileSourceDuplicateCountQuery } = await import('@/lib/concept-mapping/mapping-queries')
        const rows = await queryFileSourceOnServer(projectId, buildFileSourceDuplicateCountQuery())
        return Number(rows[0]?.removed ?? 0)
      } catch {
        return 0
      }
    }
    if (!buffer) return 0
    return countDuplicatesWasm(new Uint8Array(buffer), mapping.terminologyColumn, mapping.conceptCodeColumn)
  }, [countDuplicatesWasm])

  // Recompute the duplicate count whenever the buffer or the (vocab, code) mapping
  // changes — so it tracks manual mapping edits in import-settings too, and covers
  // editing an existing project (uses its stored buffer). WASM only; server mode /
  // Excel fall back to 0 here (the editor's universal check still reports them).
  useEffect(() => {
    const buffer = rawFileBuffer ?? editingProject?.fileSourceData?.rawFileBuffer
    if (isServerMode() || !buffer || !columnMapping.conceptCodeColumn) {
      setDuplicatesRemoved(0)
      return
    }
    let cancelled = false
    countDuplicatesWasm(new Uint8Array(buffer), columnMapping.terminologyColumn, columnMapping.conceptCodeColumn)
      .then((n) => { if (!cancelled) setDuplicatesRemoved(n) })
    return () => { cancelled = true }
  }, [rawFileBuffer, editingProject, columnMapping.terminologyColumn, columnMapping.conceptCodeColumn, countDuplicatesWasm])

  const parseCSV = useCallback((f: File) => {
    // Parse only a preview (first rows) for column detection and auto-mapping.
    // The full data is read server-side (or WASM) from the raw file at query time.
    let rowCount = 0
    let headers: string[] = []
    const previewData: Record<string, unknown>[] = []
    let headersDone = false

    const papaConfig: Papa.ParseLocalConfig<Record<string, unknown>, File> = {
      header: hasHeader,
      skipEmptyLines: true,
      dynamicTyping: true,
      encoding,
      step: (result: Papa.ParseStepResult<Record<string, unknown>>, parser) => {
        rowCount++
        if (skipRows > 0 && rowCount <= skipRows) return
        if (!headersDone) {
          headers = hasHeader
            ? (result.meta.fields ?? [])
            : Object.keys(result.data || {})
          headersDone = true
        }
        if (previewData.length < PREVIEW_ROWS) {
          previewData.push(result.data)
        } else {
          // Stop parsing — we have enough preview rows
          parser.abort()
        }
      },
      complete: async () => {
        await finishCSVParse(f, headers, previewData, rowCount)
      },
      error: () => {
        setFileError(t('datasets.upload_parse_error'))
        setFileLoading(false)
      },
    }
    if (delimiter !== 'auto') papaConfig.delimiter = delimiter
    Papa.parse(f, papaConfig)
  }, [delimiter, skipRows, encoding, hasHeader, t, applyParsedData]) // eslint-disable-line react-hooks/exhaustive-deps

  // Shared finish logic for CSV parsing (called after preview rows are collected)
  const finishCSVParse = useCallback(async (
    f: File,
    headers: string[],
    previewData: Record<string, unknown>[],
    _rowCount: number,
  ) => {
    try {
      if (headers.length === 0) {
        setFileError(t('datasets.upload_no_columns'))
        setFileLoading(false)
        return
      }
      // Preview is ready from the 20 papaparse rows — show it immediately.
      applyParsedData(headers, previewData)
      const buffer = new Uint8Array(await f.arrayBuffer())
      setRawFileBuffer(buffer)
      // Server mode: the exact count comes from the server after upload — do NOT
      // boot DuckDB-WASM here just to COUNT (that was the source of the slow
      // preview). WASM mode: no server round-trip later, so count locally now.
      if (isServerMode()) {
        setTotalRows(0)
      } else {
        setTotalRows(await countRowsWasm(buffer, 'csv'))
      }
    } catch {
      setFileError(t('datasets.upload_parse_error'))
    }
    setFileLoading(false)
  }, [t, applyParsedData, countRowsWasm])

  const parseExcel = useCallback((f: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        setSheetNames(wb.SheetNames)
        const sheetName = selectedSheet && wb.SheetNames.includes(selectedSheet)
          ? selectedSheet
          : wb.SheetNames[0]
        if (!selectedSheet && sheetName) setSelectedSheet(sheetName)
        if (!sheetName) {
          setFileError(t('datasets.upload_no_columns'))
          setFileLoading(false)
          return
        }
        const ws = wb.Sheets[sheetName]
        const serverMode = isServerMode()
        // Server mode: cap the sheet→JSON conversion to a preview so a huge
        // workbook doesn't block — the full sheet is read server-side, and the
        // exact count comes back from the server after upload. WASM mode: read
        // the whole sheet (no later server round-trip to get the count).
        let jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
          header: hasHeader ? undefined : 1,
          defval: null,
          ...(serverMode ? { sheetRows: (skipRows > 0 ? skipRows : 0) + PREVIEW_ROWS + 1 } : {}),
        })
        if (skipRows > 0) jsonData = jsonData.slice(skipRows)
        const headers = Object.keys(jsonData[0] || {}).map(String)
        if (headers.length === 0) {
          setFileError(t('datasets.upload_no_columns'))
          setFileLoading(false)
          return
        }
        applyParsedData(headers, jsonData)
        setRawFileBuffer(new Uint8Array(data))
        // applyParsedData set totalRows to the (possibly capped) preview length;
        // in server mode that's not the real total — let the server fill it in.
        if (serverMode) setTotalRows(0)
      } catch {
        setFileError(t('datasets.upload_parse_error'))
      }
      setFileLoading(false)
    }
    reader.onerror = () => {
      setFileError(t('datasets.upload_parse_error'))
      setFileLoading(false)
    }
    reader.readAsArrayBuffer(f)
  }, [skipRows, hasHeader, selectedSheet, t, applyParsedData])

  // Local (WASM) mode only — server mode parses Parquet via parseServer.
  const parseParquet = useCallback(async (f: File) => {
    try {
      const { getDuckDB } = await import('@/lib/duckdb/engine')
      const db = await getDuckDB()
      const conn = await db.connect()
      const buffer = await f.arrayBuffer()
      await db.registerFileBuffer(f.name, new Uint8Array(buffer))
      const result = await conn.query(`SELECT * FROM read_parquet('${f.name}') LIMIT ${PREVIEW_ROWS}`)
      const rows = result.toArray().map((row: Record<string, unknown>) => {
        const obj: Record<string, unknown> = {}
        for (const key of Object.keys(row)) obj[key] = row[key]
        return obj
      })
      const headers = result.schema.fields.map((field: { name: string }) => field.name)
      const countRes = await conn.query(`SELECT COUNT(*) AS total FROM read_parquet('${f.name}')`)
      const total = Number(countRes.toArray()[0]?.total ?? rows.length)
      await conn.close()
      applyParsedData(headers, rows)
      setRawFileBuffer(new Uint8Array(buffer))
      setTotalRows(total)
    } catch {
      setFileError(t('datasets.upload_parse_error'))
    }
    setFileLoading(false)
  }, [t, applyParsedData])

  // Server mode: one server parse for every format (no papaparse/xlsx/DuckDB-WASM
  // in the browser), so the previewed/auto-mapped columns are exactly what the
  // mapping query reads. Uploads once; the sha is reused at create time.
  const parseServer = useCallback(async (f: File) => {
    if (!activeWorkspaceId) {
      setFileError(t('datasets.upload_parse_error'))
      setFileLoading(false)
      return
    }
    const opts: Record<string, unknown> = {}
    if (delimiter !== 'auto') opts.delimiter = delimiter
    if (encoding !== 'UTF-8') opts.encoding = encoding
    if (skipRows > 0) opts.skipRows = skipRows
    if (!hasHeader) opts.hasHeader = false
    if (selectedSheet) opts.sheet = selectedSheet
    try {
      const { columns, rowCount, rows, sheetNames, sha } = await previewFileColumnsOnServer(
        activeWorkspaceId, f, f.name, Object.keys(opts).length > 0 ? opts : undefined, PREVIEW_ROWS,
      )
      if (sheetNames && sheetNames.length > 0) {
        setSheetNames(sheetNames)
        if (!selectedSheet) setSelectedSheet(sheetNames[0])
      }
      if (columns.length === 0) {
        setFileError(t('datasets.upload_no_columns'))
        setFileLoading(false)
        return
      }
      applyParsedData(columns, rows)
      setTotalRows(rowCount)
      setPreUploadedSha(sha)
    } catch {
      setFileError(t('datasets.upload_parse_error'))
    }
    setFileLoading(false)
  }, [activeWorkspaceId, delimiter, encoding, skipRows, hasHeader, selectedSheet, applyParsedData, t])

  const parseFile = useCallback((f: File) => {
    setFileLoading(true)
    setFileError(null)
    const supported = isCSVLike(f) || isExcel(f) || isParquet(f)
    if (!supported) {
      setFileError(t('datasets.upload_unsupported_format'))
      setFileLoading(false)
      return
    }
    if (isServerMode()) parseServer(f)
    else if (isCSVLike(f)) parseCSV(f)
    else if (isExcel(f)) parseExcel(f)
    else parseParquet(f)
  }, [isCSVLike, isExcel, isParquet, parseServer, parseCSV, parseExcel, parseParquet, t])

  // Re-parse when options change
  useEffect(() => {
    if (file && !fileLoading) parseFile(file)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delimiter, skipRows, encoding, hasHeader, selectedSheet])

  const handleFile = useCallback((f: File) => {
    setFile(f)
    setParsedColumns([])
    setParsedRows([])
    setPreviewRows([])
    setPreUploadedSha(null)
    setFileError(null)
    parseFile(f)
    setPage('import-settings')
  }, [parseFile])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [handleFile])

  const handleClearFile = useCallback(() => {
    setFile(null)
    setRawFileBuffer(null)
    setPreUploadedSha(null)
    setParsedColumns([])
    setParsedRows([])
    setPreviewRows([])
    setFileError(null)
    setColumnMapping({})
  }, [])

  const updateColumnMapping = (role: keyof FileColumnMapping, value: string | undefined) => {
    setColumnMapping((prev) => ({ ...prev, [role]: value }))
  }

  // --- Validation ---
  // In edit mode with a file source and no new file uploaded, the existing fileSourceData is sufficient.
  // In server mode the CSV bytes never come to the browser (rawFileBuffer undefined, rows empty) — the
  // file lives in the blob store — so a persisted fileName/columns is the reliable "file exists" signal.
  const hasExistingFileData = isEdit && sourceType === 'file' && !!(
    editingProject?.fileSourceData?.rawFileBuffer
    || editingProject?.fileSourceData?.rows.length
    || editingProject?.fileSourceData?.fileName
    || editingProject?.fileSourceData?.columns.length
  )
  const isFileValid = sourceType === 'file' && (
    hasExistingFileData && parsedRows.length === 0  // no new file → existing data is valid
    || (parsedColumns.length > 0 && parsedRows.length > 0 && !!columnMapping.conceptCodeColumn && !!columnMapping.terminologyColumn)
  )
  // The source is optional: a project can be created empty and get its database
  // or file later (from Edit). A half-configured FILE source is the exception —
  // columns parsed but no code/terminology column picked would persist a source
  // the editor can't read, so that still blocks.
  const fileHalfConfigured = sourceType === 'file' && parsedColumns.length > 0 && !isFileValid
  const canSubmit = !!name.trim() && !fileHalfConfigured && (isEdit || isEntityIdValid(entityId, existingIds))

  // Per-tab list of what's still missing — drives the red dot on each tab and
  // the tooltip on the disabled Create button.
  const infoMissing: string[] = []
  if (!name.trim()) infoMissing.push(t('concept_mapping.missing_name'))
  if (!isEdit && !isEntityIdValid(entityId, existingIds)) infoMissing.push(t('concept_mapping.missing_identifier'))
  const sourceMissing: string[] = []
  if (fileHalfConfigured) sourceMissing.push(t('concept_mapping.missing_file'))
  const allMissing = [...infoMissing, ...sourceMissing]

  // --- Submit ---
  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return

    if (isEdit && editingProject) {
      const changes: Partial<MappingProject> = {
        name: setLocalized(editingProject.name, language, name.trim()),
        description: setLocalized(editingProject.description, language, description.trim()),
        status,
        badges,
        sourceType,
        version: version.trim() || '0.1.0',
        ...authoring,
      }
      if (sourceType === 'database') {
        changes.dataSourceId = dataSourceId
        changes.fileSourceData = undefined
      } else if (!isFileValid && !hasExistingFileData) {
        // Switched to a file source but nothing imported yet — leave the project
        // sourceless rather than writing an empty fileSourceData shell.
        changes.dataSourceId = ''
        changes.fileSourceData = undefined
      } else {
        const newFileData = {
          fileName: file?.name ?? editingProject.fileSourceData?.fileName ?? '',
          rows: file ? [] : (editingProject.fileSourceData?.rows ?? []),  // Keep legacy rows only if no new file
          columns: parsedColumns.length > 0 ? parsedColumns : editingProject.fileSourceData?.columns ?? [],
          columnMapping,
          parseOptions: buildParseOptions(),
          rawFileBuffer: rawFileBuffer ?? editingProject.fileSourceData?.rawFileBuffer,
          totalRowCount: file ? totalRows : (editingProject.fileSourceData?.totalRowCount ?? editingProject.fileSourceData?.rows.length),
          preUploadedSha: preUploadedSha ?? undefined,
        }
        changes.dataSourceId = ''
        changes.fileSourceData = newFileData

        // If a new file was uploaded, reconcile existing mappings to new row positions
        if (file && parsedRows.length > 0) {
          await reconcileMappingsToFile(editingProject.id, newFileData)
        }
      }
      await updateMappingProject(editingProject.id, changes)
      await finishWithDuplicateCheck(
        editingProject.id,
        sourceType === 'file' ? (changes.fileSourceData?.rawFileBuffer) : undefined,
        sourceType === 'file' ? columnMapping : undefined,
        () => onOpenChange(false),
      )
    } else {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const project: MappingProject = {
        id,
        entityId: entityId || undefined,
        workspaceId: activeWorkspaceId,
        name: setLocalized(undefined, language, name.trim()),
        description: setLocalized(undefined, language, description.trim()),
        status,
        badges,
        sourceType,
        dataSourceId: sourceType === 'database' ? dataSourceId : '',
        conceptSetIds: [],
        version: version.trim() || '0.1.0',
        ...stampAuthored(),
        ...stampLineage(),
        createdAt: now,
        updatedAt: now,
      }
      // Only attach a file source when one was actually imported: the source is
      // optional, and an empty fileSourceData shell would read as a broken source
      // rather than "no source yet".
      if (sourceType === 'file' && isFileValid) {
        project.fileSourceData = {
          fileName: file?.name ?? '',
          rows: [],  // No longer store full rows — DuckDB loads from rawFileBuffer
          columns: parsedColumns,
          columnMapping,
          parseOptions: buildParseOptions(),
          rawFileBuffer: rawFileBuffer ?? undefined,
          totalRowCount: totalRows,
          preUploadedSha: preUploadedSha ?? undefined,
        }
      }
      await createMappingProject(project)
      await finishWithDuplicateCheck(
        id,
        sourceType === 'file' ? (project.fileSourceData?.rawFileBuffer) : undefined,
        sourceType === 'file' ? columnMapping : undefined,
        () => { onOpenChange(false); onCreated?.(id) },
      )
    }
  }

  // Persisted the project — now count duplicate source concepts once. If any were
  // dropped, show a one-time modal and defer `close` until the user dismisses it;
  // otherwise close straight away.
  const finishWithDuplicateCheck = async (
    projectId: string,
    buffer: Uint8Array | undefined,
    mapping: FileColumnMapping | undefined,
    close: () => void,
  ) => {
    const removed = mapping ? await countDuplicatesForProject(projectId, buffer, mapping) : 0
    if (removed > 0) {
      pendingCloseRef.current = close
      setImportDuplicates(removed)
    } else {
      close()
    }
  }

  // Cmd/Ctrl+S submits when the form is valid. `canSubmit` already encodes all the
  // validity gates; only active on the main page (not the import-settings sub-page).
  useSaveForm({
    current: canSubmit,
    baseline: false,
    onSave: handleSubmit,
    canSave: canSubmit,
    enabled: open && page === 'main',
  })

  const buildParseOptions = (): FileSourceData['parseOptions'] => {
    const opts: NonNullable<FileSourceData['parseOptions']> = {}
    if (delimiter !== 'auto') opts.delimiter = delimiter
    if (encoding !== 'UTF-8') opts.encoding = encoding
    if (skipRows > 0) opts.skipRows = skipRows
    if (!hasHeader) opts.hasHeader = false
    if (selectedSheet) opts.sheet = selectedSheet
    return Object.keys(opts).length > 0 ? opts : undefined
  }

  const showCSVOptions = file && isCSVLike(file)
  const showExcelOptions = file && isExcel(file)
  const isImportSettingsPage = page === 'import-settings'
  const importSettingsValid = parsedColumns.length > 0 && !fileLoading
    && !!columnMapping.conceptCodeColumn && !!columnMapping.terminologyColumn

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isImportSettingsPage ? 'sm:max-w-4xl max-h-[85vh] flex flex-col' : 'sm:max-w-lg'}>
        <DialogHeader>
          <DialogTitle>
            {isImportSettingsPage
              ? t('concept_mapping.import_settings_title')
              : isEdit ? t('concept_mapping.edit_project') : t('concept_mapping.new_project')}
          </DialogTitle>
          <DialogDescription>
            {isImportSettingsPage
              ? t('concept_mapping.import_settings_description')
              : isEdit ? t('concept_mapping.edit_project_description') : t('concept_mapping.new_project_description')}
          </DialogDescription>
        </DialogHeader>

        {/* ===== IMPORT SETTINGS PAGE ===== */}
        {isImportSettingsPage && (
          <div className="flex-1 overflow-auto flex flex-col gap-4 py-2">
            {/* Parse options (CSV) */}
            {showCSVOptions && (
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-1">
                  <Label>{t('datasets.upload_delimiter')}</Label>
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
                  <Label>{t('datasets.upload_encoding')}</Label>
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
                  <Label>{t('datasets.upload_skip_rows')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={skipRows}
                    onChange={(e) => setSkipRows(Math.max(0, parseInt(e.target.value) || 0))}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('datasets.upload_header')}</Label>
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
                    <Label>{t('datasets.upload_sheet')}</Label>
                    <Select value={selectedSheet} onValueChange={setSelectedSheet}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sheetNames.map((sn) => (
                          <SelectItem key={sn} value={sn}>{sn}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label>{t('datasets.upload_skip_rows')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={skipRows}
                    onChange={(e) => setSkipRows(Math.max(0, parseInt(e.target.value) || 0))}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('datasets.upload_header')}</Label>
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
            {fileError && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm text-destructive">
                <AlertCircle size={14} className="shrink-0" />
                {fileError}
              </div>
            )}

            {/* Loading */}
            {fileLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={20} className="animate-spin text-primary" />
              </div>
            )}

            {/* Column mapping */}
            {parsedColumns.length > 0 && !fileLoading && (
              <div className="grid gap-2">
                <Label>{t('concept_mapping.column_mapping')}</Label>
                <p className="text-[10px] text-muted-foreground">{t('concept_mapping.column_mapping_hint')}</p>
                <div className="grid gap-2">
                  {COLUMN_ROLE_ROWS.map((rowRoles, ri) => (
                    <div key={ri} className={`grid gap-x-4 ${rowRoles.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                      {rowRoles.map((role) => (
                        <div key={role} className="flex items-center gap-2">
                          <Label className="flex w-28 shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                            <span>{t(`concept_mapping.col_role_${role}`)}</span>
                            {(role === 'terminologyColumn' || role === 'conceptCodeColumn') && (
                              <span className="text-destructive">*</span>
                            )}
                            {role === 'conceptIdColumn' && (
                              <Tooltip delayDuration={200}>
                                <TooltipTrigger asChild>
                                  <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Info">
                                    <Info size={10} />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="max-w-xs text-xs">
                                  {t('concept_mapping.col_role_conceptIdColumn_info')}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </Label>
                          <Select
                            value={columnMapping[role as keyof FileColumnMapping] as string ?? '__none__'}
                            onValueChange={(v) => updateColumnMapping(role as keyof FileColumnMapping, v === '__none__' ? undefined : v)}
                          >
                            <SelectTrigger className="h-7 flex-1 text-[10px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__" className="text-xs text-muted-foreground">
                                {t('concept_mapping.col_role_none')}
                              </SelectItem>
                              {parsedColumns.map((col) => (
                                <SelectItem key={col} value={col} className="text-xs">{col}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Extra columns multi-select */}
                <div className="mt-2 flex items-start gap-2">
                  <Label className="w-28 shrink-0 pt-1.5 text-[10px] text-muted-foreground">
                    {t('concept_mapping.col_role_extraColumns')}
                  </Label>
                  <div className="flex-1">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm-tight" className="w-full justify-start text-[10px] font-normal">
                          {(columnMapping.extraColumns?.length ?? 0) > 0
                            ? t('concept_mapping.extra_columns_selected', { count: columnMapping.extraColumns!.length })
                            : t('concept_mapping.extra_columns_placeholder')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-2" align="start">
                        <div className="max-h-[200px] space-y-1 overflow-auto">
                          {parsedColumns
                            .filter((col) => !COLUMN_ROLE_ROWS.flat().some((role) => columnMapping[role as keyof FileColumnMapping] === col))
                            .map((col) => {
                              const checked = columnMapping.extraColumns?.includes(col) ?? false
                              return (
                                <label key={col} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted cursor-pointer">
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => {
                                      const prev = columnMapping.extraColumns ?? []
                                      const next = v ? [...prev, col] : prev.filter((c) => c !== col)
                                      setColumnMapping((m) => ({ ...m, extraColumns: next.length > 0 ? next : undefined }))
                                    }}
                                  />
                                  {col}
                                </label>
                              )
                            })}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {(columnMapping.extraColumns?.length ?? 0) > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {columnMapping.extraColumns!.map((col) => (
                          <Badge key={col} variant="secondary" className="gap-1 pr-1">
                            {col}
                            <button
                              type="button"
                              className="ml-0.5 hover:text-destructive"
                              onClick={() => setColumnMapping((m) => ({
                                ...m,
                                extraColumns: m.extraColumns?.filter((c) => c !== col),
                              }))}
                            >
                              <X size={10} />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Preview table */}
            {previewRows.length > 0 && !fileLoading && (
              <div className="flex-1 min-h-0 max-h-[300px] overflow-auto rounded border">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-muted z-10">
                    <tr>
                      <th className="border-b border-r px-2 py-1.5 text-center font-medium text-muted-foreground w-10">#</th>
                      {parsedColumns.map((col) => (
                        <th key={col} className="border-b px-2 py-1.5 text-left font-medium whitespace-nowrap">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => (
                      <tr key={i} className="hover:bg-muted/50">
                        <td className="border-b border-r px-2 py-1 text-center text-muted-foreground tabular-nums">{i + 1}</td>
                        {parsedColumns.map((col) => (
                          <td key={col} className="border-b px-2 py-1 whitespace-nowrap max-w-[200px] truncate">
                            {row[col] != null ? String(row[col]) : <span className="italic text-muted-foreground">null</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {totalRows > 10 && (
                  <div className="border-t px-2 py-1 text-[10px] text-muted-foreground bg-muted/50">
                    {t('datasets.upload_preview_hint', { shown: 10, total: totalRows.toLocaleString() })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ===== MAIN PAGE ===== */}
        {!isImportSettingsPage && (
          <div className="flex flex-col gap-4 py-2">
            <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as 'info' | 'source')}>
              <TabsList className="w-full">
                <TabsTrigger value="info" className="flex-1 gap-1.5">
                  {t('concept_mapping.tab_info')}
                  {infoMissing.length > 0 && <span className="size-1.5 rounded-full bg-destructive" />}
                </TabsTrigger>
                <TabsTrigger value="source" className="flex-1 gap-1.5">
                  {t('concept_mapping.tab_source')}
                  {sourceMissing.length > 0 && <span className="size-1.5 rounded-full bg-destructive" />}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="info" className="flex flex-col gap-4 pt-3">
            {/* Name & description */}
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="mp-name">{t('common.name')}<RequiredMark /></Label>
                <Input
                  ref={nameInputRef}
                  id="mp-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('concept_mapping.project_name_placeholder')}
                />
              </div>
                              <EntityIdField
                  name={name}
                  value={entityId}
                  onChange={setEntityId}
                  existingIds={existingIds}
                  htmlId="mp-entity-id"
                  placeholder="my-mapping-project"
                  required
                  readOnly={isEdit}
                />
              <div className="grid gap-2">
                <Label htmlFor="mp-desc">{t('common.description')}</Label>
                <Input
                  id="mp-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('concept_mapping.project_desc_placeholder')}
                />
              </div>
            </div>

            {/* Status */}
            <div className="grid gap-2">
              <Label>{t('concept_mapping.project_status')}</Label>
              <div className="flex gap-2 flex-wrap">
                {(['in_progress', 'on_hold', 'completed'] as MappingProjectStatus[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all border ${
                      status === s
                        ? 'border-transparent ' + MAPPING_STATUS_COLORS[s].bg + ' ' + MAPPING_STATUS_COLORS[s].text
                        : 'border-border bg-background text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <span className={`size-1.5 rounded-full ${status === s ? MAPPING_STATUS_COLORS[s].dot : 'bg-muted-foreground'}`} />
                    {t(`concept_mapping.project_status_${s}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Badges */}
            <div className="grid gap-2">
              <Label>{t('concept_mapping.project_badges')}</Label>
              {badges.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {badges.map((badge) => (
                    <span
                      key={badge.id}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${getBadgeClasses(badge.color)}`}
                      style={getBadgeStyle(badge.color)}
                    >
                      {localized(badge.label, language)}
                      <button
                        type="button"
                        className="ml-0.5 opacity-60 hover:opacity-100"
                        onClick={() => setBadges(badges.filter((b) => b.id !== badge.id))}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* Suggestions: badges already used in other projects of the workspace */}
              {(() => {
                const availableSuggestions = badgeSuggestions.filter((b) => !currentBadgeLabels.has(localized(b.label, language).toLowerCase()))
                if (availableSuggestions.length === 0) return null
                return (
                  <div className="rounded-md border border-dashed bg-muted/20 p-2">
                    <SectionLabel as="p" className="mb-1.5 font-normal tracking-wide">
                      {t('concept_mapping.badge_suggestions')}
                    </SectionLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {availableSuggestions.map((badge) => (
                        <button
                          key={localized(badge.label, language)}
                          type="button"
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 ${getBadgeClasses(badge.color)}`}
                          style={getBadgeStyle(badge.color)}
                          onClick={() => addBadge(badge)}
                          title={t('concept_mapping.badge_suggestion_add')}
                        >
                          <Plus size={10} />
                          {localized(badge.label, language)}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })()}
              <div className="flex flex-col gap-2">
                {(() => {
                  const trimmed = newBadgeLabel.trim()
                  const conflict = labelConflict(trimmed)
                  const errorKey = conflict === 'current'
                    ? 'concept_mapping.badge_duplicate'
                    : conflict === 'other-project'
                      ? 'concept_mapping.badge_used_elsewhere'
                      : null
                  return (
                    <>
                      <div className="flex gap-2 items-center">
                        <Input
                          value={newBadgeLabel}
                          onChange={(e) => setNewBadgeLabel(e.target.value)}
                          placeholder={t('concept_mapping.badge_label_placeholder')}
                          className={`h-8 text-xs flex-1 ${conflict ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && trimmed && !conflict) {
                              e.preventDefault()
                              addBadge({ id: '', label: trimmed, color: newBadgeColor })
                            }
                          }}
                        />
                        <BadgeColorButton value={newBadgeColor} onChange={setNewBadgeColor} />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-2"
                          disabled={!trimmed || !!conflict}
                          onClick={() => addBadge({ id: '', label: trimmed, color: newBadgeColor })}
                        >
                          <Plus size={12} />
                        </Button>
                      </div>
                      {errorKey && (
                        <p className="text-[10px] text-destructive">{t(errorKey)}</p>
                      )}
                    </>
                  )
                })()}
              </div>
            </div>

            <VersionField value={version} onChange={setVersion} />

            {isEdit && editingProject && (
              <div className="border-t pt-4">
                <AuthoringFields
                  value={{
                    createdById: 'createdById' in authoring ? authoring.createdById : editingProject.createdById,
                    createdBy: authoring.createdBy ?? editingProject.createdBy,
                    createdByDetails: authoring.createdByDetails ?? editingProject.createdByDetails,
                    organization: authoring.organization ?? editingProject.organization,
                  }}
                  onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
                />
              </div>
            )}

              </TabsContent>

              <TabsContent value="source" className="flex flex-col gap-4 pt-3">
            {/* Source type toggle */}
            <div className="grid gap-2">
              <Label>{t('concept_mapping.source_type')}</Label>
              <div className="flex gap-2">
                <Button
                  variant={sourceType === 'file' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 gap-2"
                  onClick={() => setSourceType('file')}
                >
                  <FileUp size={14} />
                  {t('concept_mapping.source_file')}
                </Button>
                <Button
                  variant={sourceType === 'database' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 gap-2"
                  onClick={() => setSourceType('database')}
                >
                  <Database size={14} />
                  {t('concept_mapping.source_database')}
                </Button>
              </div>
            </div>

            {/* Database source */}
            {sourceType === 'database' && (
              <div className="grid gap-2">
                <Label>{t('concept_mapping.select_database')}<RequiredMark /></Label>
                <Select value={dataSourceId} onValueChange={setDataSourceId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('concept_mapping.select_database')} />
                  </SelectTrigger>
                  <SelectContent>
                    {connectedDatabases.map((ds) => (
                      <SelectItem key={ds.id} value={ds.id}>
                        {ds.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* File source */}
            {sourceType === 'file' && (
              <>
                {/* Existing file in edit mode (no new file uploaded yet) */}
                {!file && hasExistingFileData && (
                  <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
                    <FileSpreadsheet size={16} className="text-emerald-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{editingProject!.fileSourceData!.fileName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {(editingProject!.fileSourceData!.totalRowCount ?? editingProject!.fileSourceData!.rows.length).toLocaleString()} {t('datasets.rows')} · {editingProject!.fileSourceData!.columns.length} {t('datasets.columns')}
                        {duplicatesRemoved > 0 && ` · ${t('concept_mapping.duplicates_removed_summary', { count: duplicatesRemoved })}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm-tight"
                      className="shrink-0"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload size={12} />
                      {t('concept_mapping.replace_file')}
                    </Button>
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
                )}

                {/* Drop zone — shown when no existing file OR new file not yet picked */}
                {!file && !hasExistingFileData && (
                  <div
                    className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors cursor-pointer ${
                      dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={handleDrop}
                  >
                    <Upload size={28} className="text-muted-foreground/50" />
                    <p className="mt-2 text-sm text-muted-foreground">{t('concept_mapping.file_drop_hint')}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">CSV, TSV, Excel (.xlsx, .xls), Parquet</p>
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
                )}

                {/* New file just uploaded */}
                {file && (
                  <div className="flex items-center gap-2 rounded-md border p-2">
                    <FileSpreadsheet size={16} className="text-emerald-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{file.name}</p>
                      {parsedColumns.length > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          {totalRows > 0 && `${totalRows.toLocaleString()} ${t('datasets.rows')} · `}
                          {parsedColumns.length} {t('datasets.columns')}
                          {duplicatesRemoved > 0 && ` · ${t('concept_mapping.duplicates_removed_summary', { count: duplicatesRemoved })}`}
                        </p>
                      )}
                    </div>
                    <Button variant="ghost" size="icon-xs" onClick={() => setPage('import-settings')} title={t('concept_mapping.import_settings_title')}>
                      <Settings2 size={14} />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={handleClearFile}>
                      <X size={14} />
                    </Button>
                  </div>
                )}
              </>
            )}
              </TabsContent>
            </Tabs>
          </div>
        )}

        {/* Footer */}
        <DialogFooter>
          {isImportSettingsPage ? (
            <div className="flex w-full items-center justify-between">
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setPage('main')}>
                <ArrowLeft size={14} />
                {t('common.back')}
              </Button>
              <Button size="sm" className="gap-1.5" onClick={() => setPage('main')} disabled={!importSettingsValid}>
                <Check size={14} />
                {t('common.validate')}
              </Button>
            </div>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              {canSubmit ? (
                <Button onClick={handleSubmit}>
                  {isEdit ? t('common.save') : t('common.create')}
                </Button>
              ) : (
                <Tooltip delayDuration={150}>
                  <TooltipTrigger asChild>
                    {/* span wrapper: a disabled button doesn't emit the hover events the tooltip needs */}
                    <span tabIndex={0}>
                      <Button disabled className="pointer-events-none">
                        {isEdit ? t('common.save') : t('common.create')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="mb-1 font-medium">{t('concept_mapping.missing_fields_title')}</p>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {allMissing.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* One-time notice: duplicate source concepts the source view will drop.
        Shown after create/import; dismissing it runs the deferred close. */}
    <AlertDialog
      open={importDuplicates !== null}
      onOpenChange={(o) => {
        if (!o) {
          setImportDuplicates(null)
          pendingCloseRef.current?.()
          pendingCloseRef.current = null
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.duplicates_removed_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('concept_mapping.duplicates_removed_desc', { count: importDuplicates ?? 0 })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => {
            setImportDuplicates(null)
            pendingCloseRef.current?.()
            pendingCloseRef.current = null
          }}>{t('common.ok')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
