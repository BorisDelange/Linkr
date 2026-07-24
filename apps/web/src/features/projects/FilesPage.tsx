import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type * as Monaco from 'monaco-editor'
import {
  FileCode,
  FilePlus,
  FolderPlus,
  FolderCog,
  Upload,
  PanelLeft,
  Terminal,
  Settings2,
  Keyboard,
  RefreshCw,
  Plug,
  X,
  Lock,
  Eye,
  EyeOff,
  ChevronLeft,
  ChevronRight,
  Play,
  ChevronDown,
  Plus,
  FileDown,
  FileText,
  Code,
  Loader2,
  Download,
  LayoutGrid,
  PanelRight,
  Check,
  XCircle,
  Table2,
  Save,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { useFileStore } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useConnectionStore } from '@/stores/connection-store'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useProjectTree } from '@/hooks/use-project-tree'
import { useResolvedDirs } from '@/hooks/use-resolved-dirs'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { isServerMode } from '@/lib/api-client'
import { executeOnServer } from '@/lib/api/execution'
import { queryDatasetRows } from '@/lib/api/datasets'
import { executePython } from '@/lib/runtimes/pyodide-engine'
import { executeR } from '@/lib/runtimes/webr-engine'
import { FileTree } from './files/FileTree'
import { OutputPanel, getTabIcon } from './files/OutputPanel'
import { CreateFileDialog } from './files/CreateFileDialog'
import { CreateFolderDialog } from './files/CreateFolderDialog'
import { UploadDialog } from './files/UploadDialog'
import { RunButton } from './files/RunButton'
import { SessionDropdown } from '@/components/execution/SessionDropdown'
import { PythonLogo, RLogo } from '@/components/ui/language-icon'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { useSessionStore } from '@/stores/session-store'
import { KeyboardShortcutsDialog } from './files/KeyboardShortcutsDialog'
import { SchemaBrowserDialog } from '@/features/warehouse/databases/SchemaBrowserDialog'
import { EditorSettingsDialog } from './files/EditorSettingsDialog'
import { ConnectionsPanel } from './files/ConnectionsPanel'
import { useGlobalShortcuts, type ShortcutHandlers } from '@/hooks/use-shortcuts'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { useShortcutStore } from '@/stores/shortcut-store'

const LazyRmdNotebook = lazy(() => import('./files/RmdNotebook').then(m => ({ default: m.RmdNotebook })))
const LazyIpynbNotebook = lazy(() => import('./files/IpynbNotebook').then(m => ({ default: m.IpynbNotebook })))
import type { RmdNotebookHandle, CellState } from './files/RmdNotebook'
import type { RmdCell } from '@/lib/rmd-parser'
import type { IpynbNotebookHandle } from './files/IpynbNotebook'

export function FilesPage() {
  const { t } = useTranslation()
  const {
    selectedFileId,
    openFileIds,
    updateFileContent,
    selectFile,
    closeFile,
    reorderOpenFiles,
    outputTabs,
    outputTabOrder,
    activeOutputTab,
    executionResults,
    addExecutionResult,
    updateExecutionResult,
    addOutputTab,
    setActiveOutputTab,
    closeOutputTab,
    reorderAllOutputTabs,
    clearExecutionResults,
    outputVisible,
    setOutputVisible,
    terminalTabs,
    openTerminalTab,
    closeTerminalTab,
    selectTerminalTab,
    loadProjectFiles,
    reloadFromDisk,
    isFileDirty,
    saveFile,
    revertFile,
    _dirtyVersion,
    editorModeFileIds,
  } = useFileStore()
  const { activeProjectUid } = useAppStore()
  const canWriteIde = useMyProjectRole(activeProjectUid ?? undefined).can('ide:write')
  const { activeConnectionId, loadProjectConnections, getProjectConnections, setActiveConnection } = useConnectionStore()
  const { isExecuting, startExecution, stopExecution, finishExecution } = useRuntimeStore()
  const loadDataSources = useDataSourceStore((s) => s.loadDataSources)
  const dataSourcesLoaded = useDataSourceStore((s) => s.dataSourcesLoaded)
  const loadCohorts = useCohortStore((s) => s.loadCohorts)
  const loadPipelines = usePipelineStore((s) => s.loadPipelines)
  const { loadProjectDatasets, loadFileData, getFileRows, files: datasetFiles, _dirtyVersion: _datasetDirtyVersion } = useDatasetStore()
  const { nodes } = useProjectTree(activeProjectUid)
  const idePath = useAppStore((s) => s._projectsRaw.find((p) => p.uid === activeProjectUid)?.idePath)
  const resolvedDirs = useResolvedDirs(activeProjectUid, idePath ?? '')

  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  // Folder the create dialogs target (null = scripts root). Set by the toolbar
  // (null) or a folder's right-click "New file / New folder" (that folder).
  const [createParentId, setCreateParentId] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false)
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [dragFileId, setDragFileId] = useState<string | null>(null)
  const [dropFileInsert, setDropFileInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [dragOutputTabId, setDragOutputTabId] = useState<string | null>(null)
  const [dropOutputInsert, setDropOutputInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)

  // --- Tab scroll with arrows (file tabs) ---
  const fileTabScrollRef = useRef<HTMLDivElement>(null)
  const [fileTabCanScrollLeft, setFileTabCanScrollLeft] = useState(false)
  const [fileTabCanScrollRight, setFileTabCanScrollRight] = useState(false)

  const updateFileTabScroll = useCallback(() => {
    const el = fileTabScrollRef.current
    if (!el) return
    setFileTabCanScrollLeft(el.scrollLeft > 0)
    setFileTabCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateFileTabScroll()
    const el = fileTabScrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateFileTabScroll)
    const ro = new ResizeObserver(updateFileTabScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateFileTabScroll)
      ro.disconnect()
    }
  }, [updateFileTabScroll, openFileIds.length])

  // --- Tab scroll with arrows (output tabs) ---
  const outputTabScrollRef = useRef<HTMLDivElement>(null)
  const [outputTabCanScrollLeft, setOutputTabCanScrollLeft] = useState(false)
  const [outputTabCanScrollRight, setOutputTabCanScrollRight] = useState(false)

  const updateOutputTabScroll = useCallback(() => {
    const el = outputTabScrollRef.current
    if (!el) return
    setOutputTabCanScrollLeft(el.scrollLeft > 0)
    setOutputTabCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateOutputTabScroll()
    const el = outputTabScrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateOutputTabScroll)
    const ro = new ResizeObserver(updateOutputTabScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateOutputTabScroll)
      ro.disconnect()
    }
  }, [updateOutputTabScroll, outputTabOrder.length])

  const scrollTabs = useCallback((ref: React.RefObject<HTMLDivElement | null>, dir: 'left' | 'right') => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  // Load connections, files, and other stores when the project changes
  useEffect(() => {
    if (activeProjectUid) {
      loadProjectConnections(activeProjectUid)
      loadProjectFiles(activeProjectUid)
      loadDataSources()
      loadCohorts()
      loadPipelines()
      loadProjectDatasets(activeProjectUid)
    }
  }, [activeProjectUid, loadProjectConnections, loadProjectFiles, loadDataSources, loadCohorts, loadPipelines, loadProjectDatasets])

  // Auto-select first database connection when none is active
  useEffect(() => {
    if (!activeProjectUid || activeConnectionId) return
    const connections = getProjectConnections(activeProjectUid)
    if (connections.length > 0) {
      setActiveConnection(connections[0].id)
    }
  }, [activeProjectUid, activeConnectionId, dataSourcesLoaded, getProjectConnections, setActiveConnection])

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  // Keep-alive: one ref per open notebook file, so switching tabs doesn't destroy state.
  const notebookRefsMap = useRef<Map<string, RmdNotebookHandle | IpynbNotebookHandle>>(new Map())
  // Convenience accessor for the active notebook (used by toolbar buttons).
  // Updated both during render AND in callback refs to avoid stale null.
  const notebookRef = useRef<RmdNotebookHandle | IpynbNotebookHandle | null>(null)
  const selectedFileIdRef = useRef(selectedFileId)
  selectedFileIdRef.current = selectedFileId
  notebookRef.current = selectedFileId ? (notebookRefsMap.current.get(selectedFileId) ?? null) : null

  /** Callback ref for notebook components — keeps notebookRefsMap and notebookRef in sync */
  const makeNotebookRef = useCallback((fid: string) => (handle: RmdNotebookHandle | IpynbNotebookHandle | null) => {
    if (handle) {
      notebookRefsMap.current.set(fid, handle)
      // Also update notebookRef immediately if this is the active file
      if (fid === selectedFileIdRef.current) notebookRef.current = handle
    } else {
      notebookRefsMap.current.delete(fid)
    }
  }, [])

  const selectedNode = nodes.find((n) => n.id === selectedFileId)
  const activeTerminalTab = terminalTabs.find((t) => t.id === selectedFileId)
  const activeSessionId = useSessionStore(
    (s) => (activeProjectUid ? s.getActiveSessionId(activeProjectUid) : undefined),
  )
  const isVirtualFile = selectedNode?.virtual === true
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0
  const selectedLanguage = selectedNode?.language
  const isSql = selectedLanguage === 'sql' || selectedNode?.name.endsWith('.sql')
  const isIpynbFile = selectedNode?.name.endsWith('.ipynb') ?? false
  const isRmdNotebook = /\.(rmd|qmd)$/i.test(selectedNode?.name ?? '')
  const isNotebook = isIpynbFile || isRmdNotebook
  const [outlineVisible, setOutlineVisible] = useState(
    () => localStorage.getItem('linkr-notebook-outline') !== 'false'
  )

  // Outline: poll notebook cells for the sidebar
  const [outlineCells, setOutlineCells] = useState<RmdCell[]>([])
  const [outlineCellStates, setOutlineCellStates] = useState<Map<string, CellState>>(new Map())

  useEffect(() => {
    if (!outlineVisible || !isNotebook) return
    const update = () => {
      const ref = notebookRef.current
      if (!ref) return
      setOutlineCells(ref.getCells())
      setOutlineCellStates(ref.getCellStates())
    }
    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [outlineVisible, isNotebook])

  // When a dataset file is selected, redirect it to an output tab (the dataset
  // viewer) instead of a file tab showing raw JSON. Matches both the legacy
  // bridge id and the read-only IDE-tree node id (virtual:datasets/node/<id>).
  useEffect(() => {
    const DS_NODE_PREFIX = 'virtual:datasets/node/'
    const isBridgeId = selectedFileId?.startsWith('ds-bridge:')
    const isDsNodeId = selectedFileId?.startsWith(DS_NODE_PREFIX)
    if (!isBridgeId && !isDsNodeId) return
    const node = nodes.find((n) => n.id === selectedFileId)
    if (!node || node.type !== 'file') return

    const dsFileId = isBridgeId
      ? selectedFileId!.replace('ds-bridge:', '')
      : selectedFileId!.slice(DS_NODE_PREFIX.length)
    const dsFile = datasetFiles.find((f) => f.id === dsFileId)
    if (!dsFile) return

    closeFile(selectedFileId!)

    // Load data then open as output tab.
    const outputTabId = `dataset:${dsFileId}`
    const columns = dsFile.columns ?? []
    const headers = columns.map((c) => c.name)
    const toTable = (rows: Record<string, unknown>[]) => ({
      headers,
      rows: rows.map((row) => columns.map((c) => (row[c.id] != null ? String(row[c.id]) : ''))),
    })
    const open = (content: { headers: string[]; rows: string[][] }) => {
      addOutputTab({ id: outputTabId, label: dsFile.name, type: 'table', content })
      setOutputVisible(true)
      setEditorVisible(false)
    }

    if (isServerMode()) {
      // Rows live in a server-side Parquet; fetch a bounded preview page instead
      // of getFileRows (which is empty in server mode).
      queryDatasetRows(dsFileId, { offset: 0, limit: 1000 })
        .then((page) => open(toTable(page.rows)))
        .catch(() => open({ headers, rows: [] }))
    } else {
      loadFileData(dsFileId).then(() => open(toTable(getFileRows(dsFileId))))
    }
  }, [selectedFileId, nodes, datasetFiles, closeFile, loadFileData, getFileRows, addOutputTab, setOutputVisible, setEditorVisible])

  // When a CSV/TSV IDE file is selected, open it as a table in the output panel
  // (skip if the file was explicitly opened in editor mode via context menu)
  useEffect(() => {
    if (!selectedFileId || selectedFileId.startsWith('ds-bridge:') || selectedFileId.startsWith('virtual:')) return
    if (editorModeFileIds.has(selectedFileId)) return
    const node = nodes.find((n) => n.id === selectedFileId)
    if (!node || node.type !== 'file') return
    const ext = node.name.split('.').pop()?.toLowerCase()
    if (ext !== 'csv' && ext !== 'tsv') return
    const content = node.content ?? ''
    if (!content.trim()) return

    const delimiter = ext === 'tsv' ? '\t' : ','
    const lines = content.split('\n').filter((l) => l.trim())
    if (lines.length < 1) return
    const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''))
    const tableRows = lines.slice(1, 1001).map((line) =>
      line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''))
    )

    addOutputTab({
      id: `csv-preview:${selectedFileId}`,
      label: node.name,
      type: 'table',
      content: { headers, rows: tableRows },
    })
    setOutputVisible(true)
  }, [selectedFileId, nodes, addOutputTab, setOutputVisible, editorModeFileIds])

  // Show editor pane when a file in editor mode is selected (e.g. CSV edit)
  useEffect(() => {
    if (selectedFileId && editorModeFileIds.has(selectedFileId) && !editorVisible) {
      setEditorVisible(true)
    }
  }, [selectedFileId, editorModeFileIds, editorVisible])

  // Switching TO a real code file (e.g. creating a script while a dataset viewer
  // is showing) should bring the editor to the front and hide the dataset output —
  // otherwise the new script stays hidden behind the still-visible table. Fires
  // only on an actual selection change, so the eye toggle can still hide the editor.
  const lastCodeFileRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedNode || selectedNode.type !== 'file' || isVirtualFile) return
    if (selectedFileId === lastCodeFileRef.current) return
    lastCodeFileRef.current = selectedFileId ?? null
    setEditorVisible(true)
    setOutputVisible(false)
  }, [selectedFileId, selectedNode, isVirtualFile, setOutputVisible])

  // When no file is selected: auto-select first open file, or hide editor if only output tabs remain
  useEffect(() => {
    if (selectedNode) return
    // A terminal tab is active — it's a valid selection even though it's not a
    // file node; don't yank selection back to a file.
    if (activeTerminalTab) return
    // Re-select the first open file tab if available
    if (openFileIds.length > 0) {
      selectFile(openFileIds[0])
      return
    }
    // No file tabs open but output tabs exist — hide editor, show output
    if (hasOutput && editorVisible) {
      setEditorVisible(false)
      setOutputVisible(true)
    }
  }, [selectedNode, activeTerminalTab, hasOutput, editorVisible, openFileIds, selectFile, setOutputVisible])

  // CSV column colorization in Monaco — apply inline decorations per column
  const csvDecorationsRef = useRef<string[]>([])
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !selectedFileId) {
      csvDecorationsRef.current = []
      return
    }
    const node = nodes.find((n) => n.id === selectedFileId)
    if (!node || node.type !== 'file') return
    const ext = node.name.split('.').pop()?.toLowerCase()
    if (ext !== 'csv' && ext !== 'tsv') {
      if (csvDecorationsRef.current.length > 0) {
        csvDecorationsRef.current = editor.deltaDecorations(csvDecorationsRef.current, [])
      }
      return
    }
    const content = node.content ?? ''
    if (!content.trim()) return

    const delimiter = ext === 'tsv' ? '\t' : ','
    const lines = content.split('\n')
    const decorations: Monaco.editor.IModelDeltaDecoration[] = []
    // Column color classes (must match injected CSS below)
    const colClasses = [
      'csv-col-0', 'csv-col-1', 'csv-col-2', 'csv-col-3',
      'csv-col-4', 'csv-col-5', 'csv-col-6', 'csv-col-7',
      'csv-col-8', 'csv-col-9', 'csv-col-10', 'csv-col-11',
    ]

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]
      if (!line.trim()) continue
      // Simple CSV split (handles basic cases, not quoted delimiters)
      let colIdx = 0
      let pos = 0
      const lineNum = lineIdx + 1
      while (pos < line.length) {
        const start = pos
        if (line[pos] === '"') {
          // Quoted field
          pos++
          while (pos < line.length && !(line[pos] === '"' && (pos + 1 >= line.length || line[pos + 1] === delimiter))) {
            pos++
          }
          if (pos < line.length) pos++ // closing quote
          if (pos < line.length && line[pos] === delimiter) pos++ // delimiter
        } else {
          while (pos < line.length && line[pos] !== delimiter) pos++
          if (pos < line.length) pos++ // delimiter
        }
        decorations.push({
          range: { startLineNumber: lineNum, startColumn: start + 1, endLineNumber: lineNum, endColumn: (pos < line.length || line[pos - 1] === delimiter) ? pos : pos + 1 },
          options: { inlineClassName: colClasses[colIdx % colClasses.length] },
        })
        colIdx++
      }
    }
    csvDecorationsRef.current = editor.deltaDecorations(csvDecorationsRef.current, decorations)
  }, [selectedFileId, nodes])

  // Inject CSV column color CSS once
  useEffect(() => {
    const id = 'linkr-csv-col-styles'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      .csv-col-0 { color: #3b82f6 !important; }
      .csv-col-1 { color: #8b5cf6 !important; }
      .csv-col-2 { color: #10b981 !important; }
      .csv-col-3 { color: #f59e0b !important; }
      .csv-col-4 { color: #ef4444 !important; }
      .csv-col-5 { color: #06b6d4 !important; }
      .csv-col-6 { color: #ec4899 !important; }
      .csv-col-7 { color: #84cc16 !important; }
      .csv-col-8 { color: #6366f1 !important; }
      .csv-col-9 { color: #14b8a6 !important; }
      .csv-col-10 { color: #f97316 !important; }
      .csv-col-11 { color: #a855f7 !important; }
    `
    document.head.appendChild(style)
  }, [])

  /** Execute SQL against the active DuckDB connection. */
  const executeSql = useCallback(
    async (sql: string, label: string) => {
      if (!activeConnectionId) return
      const start = Date.now()

      try {
        const rows = await duckdbEngine.queryDataSource(activeConnectionId, sql)
        const duration = Date.now() - start

        addExecutionResult({
          id: `exec-${Date.now()}`,
          fileName: label,
          language: 'sql',
          timestamp: start,
          duration,
          success: true,
          output: `${rows.length} row${rows.length !== 1 ? 's' : ''} returned in ${duration}ms`,
          code: sql,
        })

        if (rows.length > 0) {
          const headers = Object.keys(rows[0])
          const tableRows = rows.slice(0, 1000).map((row) =>
            headers.map((h) => String(row[h] ?? ''))
          )
          addOutputTab({
            id: `sql-result-${label}`,
            label: `Result — ${label}`,
            type: 'table',
            content: { headers, rows: tableRows },
          })
        }
      } catch (err) {
        const duration = Date.now() - start
        const message = err instanceof Error ? err.message : String(err)
        addExecutionResult({
          id: `exec-${Date.now()}`,
          fileName: label,
          language: 'sql',
          timestamp: start,
          duration,
          success: false,
          output: message,
          code: sql,
        })
      }
    },
    [activeConnectionId, addExecutionResult, addOutputTab]
  )

  /** Execute Python or R code via Pyodide / webR WASM runtimes. */
  const executeCode = useCallback(
    async (code: string, fileName: string, language: 'python' | 'r') => {
      const start = Date.now()
      const execId = `exec-${start}`

      // Show a pending result immediately so the output panel opens
      addExecutionResult({
        id: execId,
        fileName,
        language,
        timestamp: start,
        duration: 0,
        success: true,
        output: language === 'python' ? t('runtime.loading_python') : t('runtime.loading_r'),
        code,
      })

      const controller = startExecution()
      try {
        // Server mode: run on the backend (data stays server-side). The active
        // connection / dataset injection is a later step (e4) — MVP runs free code.
        const result = isServerMode()
          ? await executeOnServer(language, code, {
              projectUid: activeProjectUid ?? undefined,
              connectionId: activeConnectionId ?? undefined,
            })
          : language === 'python'
            ? await executePython(code, activeConnectionId, controller.signal)
            : await executeR(code, activeConnectionId, controller.signal)

        const duration = Date.now() - start
        const success = !result.stderr

        updateExecutionResult(execId, {
          duration,
          success,
          output: success
            ? result.stdout || `Executed in ${duration}ms`
            : result.stderr,
        })

        for (const fig of result.figures) {
          addOutputTab({
            id: fig.id,
            label: `${fig.label} — ${fileName}`,
            type: 'figure',
            content: fig.data,
          })
          setActiveOutputTab(fig.id)
        }

        if (result.table) {
          addOutputTab({
            id: `table-${Date.now()}`,
            label: `Result — ${fileName}`,
            type: 'table',
            content: result.table,
          })
        }
      } catch (err) {
        const duration = Date.now() - start
        const message = err instanceof Error ? err.message : String(err)
        updateExecutionResult(execId, {
          duration,
          success: false,
          output: message,
        })
      } finally {
        finishExecution()
      }
    },
    [activeConnectionId, activeProjectUid, t, startExecution, finishExecution, addExecutionResult, updateExecutionResult, addOutputTab, setActiveOutputTab]
  )

  const isMarkdown = selectedLanguage === 'markdown' || selectedNode?.name.endsWith('.md')

  const runCode = useCallback(
    (code: string, label: string) => {
      if (isMarkdown) {
        // Markdown has no partial run: always render the whole file, whatever the
        // trigger (Run file / selection / line).
        const name = selectedNode?.name ?? label
        addOutputTab({
          id: `markdown-${name}`,
          label: `Preview — ${name}`,
          type: 'markdown',
          content: selectedNode?.content ?? code,
        })
        setOutputVisible(true)
      } else if (isSql && activeConnectionId) {
        executeSql(code, label)
      } else if (selectedLanguage === 'python') {
        executeCode(code, label, 'python')
      } else if (selectedLanguage === 'r') {
        executeCode(code, label, 'r')
      }
    },
    [isMarkdown, isSql, activeConnectionId, executeSql, executeCode, selectedLanguage, selectedNode, addOutputTab, setOutputVisible]
  )

  const handleRunFile = useCallback(() => {
    if (!selectedNode?.content) return
    runCode(selectedNode.content, selectedNode.name)
  }, [selectedNode, runCode])

  const handleRunSelection = useCallback(() => {
    if (!editorRef.current || !selectedNode) return
    const selection = editorRef.current.getSelection()
    if (!selection) return
    const model = editorRef.current.getModel()
    if (!model) return
    const text = model.getValueInRange(selection)
    if (text.trim()) {
      runCode(text, `${selectedNode.name} (selection)`)
    }
  }, [selectedNode, runCode])

  const handleRunLine = useCallback(() => {
    if (!editorRef.current || !selectedNode) return
    const position = editorRef.current.getPosition()
    if (!position) return
    const model = editorRef.current.getModel()
    if (!model) return
    const lineContent = model.getLineContent(position.lineNumber)
    if (lineContent.trim()) {
      runCode(lineContent, `${selectedNode.name}:${position.lineNumber}`)
    }
  }, [selectedNode, runCode])

  // Cmd+Enter: run selection if any, otherwise run current line (RStudio convention)
  const handleRunSelectionOrLine = useCallback(() => {
    if (!editorRef.current || !selectedNode) return
    const selection = editorRef.current.getSelection()
    const model = editorRef.current.getModel()
    if (selection && model && !selection.isEmpty()) {
      const text = model.getValueInRange(selection)
      if (text.trim()) {
        runCode(text, `${selectedNode.name} (selection)`)
        return
      }
    }
    // Fallback: run current line
    handleRunLine()
  }, [selectedNode, runCode, handleRunLine])

  // Cmd+S: force flush debounced content save
  const handleSaveFile = useCallback(() => {
    if (!selectedNode || isVirtualFile) return
    saveFile(selectedNode.id)
    // If this is a CSV/TSV file opened in editor mode, refresh its output tab
    const ext = selectedNode.name.split('.').pop()?.toLowerCase()
    if ((ext === 'csv' || ext === 'tsv') && editorModeFileIds.has(selectedNode.id)) {
      const content = selectedNode.content ?? ''
      const delimiter = ext === 'tsv' ? '\t' : ','
      const lines = content.split('\n').filter((l: string) => l.trim())
      if (lines.length > 0) {
        const headers = lines[0].split(delimiter).map((h: string) => h.trim().replace(/^"|"$/g, ''))
        const tableRows = lines.slice(1, 1001).map((line: string) =>
          line.split(delimiter).map((cell: string) => cell.trim().replace(/^"|"$/g, ''))
        )
        addOutputTab({
          id: `csv-preview:${selectedNode.id}`,
          label: selectedNode.name,
          type: 'table',
          content: { headers, rows: tableRows },
        })
      }
    }
  }, [selectedNode, isVirtualFile, saveFile, editorModeFileIds, addOutputTab])

  const handleCloseFile = useCallback((fid: string) => {
    if (isFileDirty(fid)) {
      setCloseConfirmFileId(fid)
    } else {
      closeFile(fid)
    }
  }, [isFileDirty, closeFile])

  const handleSaveAndClose = useCallback(async () => {
    if (!closeConfirmFileId) return
    await saveFile(closeConfirmFileId)
    closeFile(closeConfirmFileId)
    setCloseConfirmFileId(null)
  }, [closeConfirmFileId, saveFile, closeFile])

  const handleDiscardAndClose = useCallback(() => {
    if (!closeConfirmFileId) return
    revertFile(closeConfirmFileId)
    closeFile(closeConfirmFileId)
    setCloseConfirmFileId(null)
  }, [closeConfirmFileId, revertFile, closeFile])

  const handleCloseAllFiles = useCallback(() => {
    for (const fid of openFileIds) closeFile(fid)
  }, [openFileIds, closeFile])

  const handleCloseOtherFiles = useCallback((keepId: string) => {
    for (const fid of openFileIds) {
      if (fid !== keepId) closeFile(fid)
    }
  }, [openFileIds, closeFile])

  const handleCloseAllOutputTabs = useCallback(() => {
    clearExecutionResults()
    for (const tab of outputTabs) closeOutputTab(tab.id)
  }, [outputTabs, closeOutputTab, clearExecutionResults])

  const handleCloseOtherOutputTabs = useCallback((keepId: string) => {
    if (keepId === '__exec_console__') {
      for (const tab of outputTabs) closeOutputTab(tab.id)
    } else {
      clearExecutionResults()
      for (const tab of outputTabs) {
        if (tab.id !== keepId) closeOutputTab(tab.id)
      }
    }
  }, [outputTabs, closeOutputTab, clearExecutionResults])

  // Cmd+K from a script editor: clear ONLY the Console output tab. A terminal has
  // its own Cmd+K (handled inside xterm) that clears its scrollback, not this.
  const handleClearTerminal = useCallback(() => {
    clearExecutionResults()
  }, [clearExecutionResults])

  // Open a create dialog targeting a folder (null = scripts root).
  const openCreate = useCallback((parentId: string | null, folderMode: boolean) => {
    setCreateParentId(parentId)
    if (folderMode) setCreateFolderOpen(true)
    else setCreateFileOpen(true)
  }, [])

  // Cmd+N: open new file dialog
  const handleNewFile = useCallback(() => {
    openCreate(null, false)
  }, [openCreate])

  // Global shortcuts (scope: 'global')
  const globalHandlers: ShortcutHandlers = useMemo(
    () => ({
      toggle_terminal: () => openTerminalTab('bash'),
      new_file: handleNewFile,
      clear_terminal: handleClearTerminal,
    }),
    [openTerminalTab, handleNewFile, handleClearTerminal]
  )
  useGlobalShortcuts(globalHandlers)

  // Force CodeEditor remount when editor-scoped bindings change
  const shortcutVersion = useShortcutStore((s) =>
    JSON.stringify([
      s.shortcuts.save_file.binding,
      s.shortcuts.run_selection_or_line.binding,
      s.shortcuts.run_file.binding,
    ])
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full overflow-hidden">
        <Allotment>
          {/* Explorer sidebar — full height */}
          <Allotment.Pane
            preferredSize={240}
            minSize={140}
            maxSize={400}
            visible={explorerVisible}
          >
            <div className="flex h-full flex-col border-r">
              {/* Explorer header */}
              <div className="flex items-center justify-between border-b px-2 py-1.5">
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!canWriteIde}
                        onClick={() => openCreate(null, false)}
                      >
                        <FilePlus size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.new_file')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!canWriteIde}
                        onClick={() => openCreate(null, true)}
                      >
                        <FolderPlus size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.new_folder')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!canWriteIde}
                        onClick={() => setUploadOpen(true)}
                      >
                        <Upload size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.upload')}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => { if (activeProjectUid) reloadFromDisk(activeProjectUid) }}
                        disabled={!activeProjectUid}
                      >
                        <RefreshCw size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('files.refresh_files')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setExplorerVisible(false)}
                      >
                        <PanelLeft size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('files.collapse_explorer')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              {resolvedDirs && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
                      <FolderCog size={11} className="shrink-0" />
                      <span className="truncate font-mono" title={resolvedDirs.ide}>{resolvedDirs.ide}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-md break-all font-mono text-xs">
                    {resolvedDirs.ide}
                  </TooltipContent>
                </Tooltip>
              )}
              <FileTree onNewChild={openCreate} />
            </div>
          </Allotment.Pane>

          {/* Editor area — full height */}
          <Allotment.Pane minSize={150}>
            <div className="flex h-full flex-col">
              {/* Editor toolbar */}
              <div className="flex items-center gap-1 border-b px-3 py-1.5">
                {/* Left: expand explorer (when hidden) + run */}
                {!explorerVisible && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setExplorerVisible(true)}
                      >
                        <PanelLeft size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('files.expand_explorer')}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Session selector for an active R/Python terminal tab — on the
                    left, like a script's (files get theirs next to Run). */}
                {activeTerminalTab && (activeTerminalTab.kind === 'python' || activeTerminalTab.kind === 'r') && activeProjectUid && (
                  <SessionDropdown projectUid={activeProjectUid} />
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={editorVisible ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      onClick={() => setEditorVisible(!editorVisible)}
                    >
                      {editorVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('files.toggle_editor')}</TooltipContent>
                </Tooltip>

                {editorVisible && selectedNode && !isVirtualFile && !isIpynbFile && !isRmdNotebook && (
                  <>
                    <div className="mx-1 h-4 w-px bg-border" />
                    <RunButton
                      onRunFile={handleRunFile}
                      onRunSelection={handleRunSelection}
                      onRunLine={handleRunLine}
                      onStop={stopExecution}
                      isSql={isSql}
                      isExecuting={isExecuting}
                      language={selectedLanguage as 'python' | 'r' | undefined}
                      projectUid={activeProjectUid ?? undefined}
                    />
                    {/* Session (kernel namespace) selector — server mode, R/Python only. */}
                    {(selectedLanguage === 'python' || selectedLanguage === 'r') && activeProjectUid && (
                      <SessionDropdown projectUid={activeProjectUid} />
                    )}
                    {/* Save current file (Cmd+S) — after the environments dropdown */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={handleSaveFile}
                          disabled={_dirtyVersion < 0 || !isFileDirty(selectedNode.id) || !canWriteIde}
                        >
                          <Save size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('files.save')} (⌘S)</TooltipContent>
                    </Tooltip>
                    {isSql && activeConnectionId && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setSchemaDialogOpen(true)}
                          >
                            <Table2 size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('sql_scripts.browse_schema')}</TooltipContent>
                      </Tooltip>
                    )}
                  </>
                )}

                {/* Notebook toolbar buttons (Rmd/Qmd/ipynb) */}
                {editorVisible && selectedNode && (isRmdNotebook || isIpynbFile) && !isVirtualFile && (
                  <>
                    <div className="mx-1 h-4 w-px bg-border" />
                    <div className="flex items-center gap-1.5">
                      {/* Run cell and advance + dropdown */}
                      <div className="flex">
                        <Button
                          size="xs"
                          className="gap-1 rounded-r-none"
                          onClick={() => notebookRef.current?.runCellAndAdvance()}
                        >
                          <Play size={12} />
                          {t('shortcuts.nb_run_chunk')}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="xs"
                              className="rounded-l-none border-l border-primary-foreground/20 px-1"
                            >
                              <ChevronDown size={12} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => notebookRef.current?.runCellAndAdvance()}>
                              {t('shortcuts.nb_run_chunk')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.runCell()}>
                              {t('shortcuts.nb_run_chunk_stay')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.runAll()}>
                              {t('shortcuts.nb_run_all')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.runAbove()}>
                              {t('shortcuts.nb_run_above')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* ipynb: Download dropdown / Rmd: Render + dropdown */}
                      {isIpynbFile ? (
                        <div className="flex">
                          <Button
                            variant="outline"
                            size="xs"
                            className="gap-1 rounded-r-none"
                            onClick={() => (notebookRef.current as IpynbNotebookHandle)?.downloadNotebook(true)}
                          >
                            <Download size={12} />
                            Download
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="xs"
                                className="rounded-l-none border-l-0 px-1"
                              >
                                <ChevronDown size={12} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem onClick={() => (notebookRef.current as IpynbNotebookHandle)?.downloadNotebook(true)}>
                                Download with outputs
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => (notebookRef.current as IpynbNotebookHandle)?.downloadNotebook(false)}>
                                Download without outputs
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ) : (
                        <div className="flex">
                          <Button
                            variant="outline"
                            size="xs"
                            className="gap-1 rounded-r-none"
                            onClick={() => notebookRef.current?.renderPreview()}
                          >
                            <FileDown size={12} />
                            Render
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="xs"
                                className="rounded-l-none border-l-0 px-1"
                              >
                                <ChevronDown size={12} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem onClick={() => notebookRef.current?.renderPreview()}>
                                Preview
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => notebookRef.current?.renderHtml()}>
                                Download HTML
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}

                      {/* Add cell + dropdown */}
                      <div className="flex">
                        <Button
                          variant="outline"
                          size="xs"
                          className="gap-1 rounded-r-none"
                          onClick={() => notebookRef.current?.addCell('code', 'r')}
                        >
                          <Plus size={12} />
                          Add R cell
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline"
                              size="xs"
                              className="rounded-l-none border-l-0 px-1"
                            >
                              <ChevronDown size={12} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('code', 'r')}>
                              <Code size={14} /> R
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('code', 'python')}>
                              <Code size={14} /> Python
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('code', 'sql')}>
                              <Code size={14} /> SQL
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('markdown')}>
                              <FileText size={14} /> Markdown
                            </DropdownMenuItem>
                            {!notebookRef.current?.hasYamlCell && (
                              <DropdownMenuItem onClick={() => notebookRef.current?.addCell('yaml')}>
                                <Settings2 size={14} /> YAML front-matter
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* Markdown / Cells toggle */}
                      <Button
                        variant="outline"
                        size="xs"
                        className="gap-1"
                        onClick={() => notebookRef.current?.toggleSourceView()}
                      >
                        {notebookRef.current?.sourceView
                          ? <><LayoutGrid size={12} /> {t('files.view_cells')}</>
                          : <><FileCode size={12} /> {t('files.view_markdown')}</>
                        }
                      </Button>
                    </div>
                  </>
                )}

                <div className="ml-auto flex items-center gap-1">
                  {/* Order: editor settings, keyboard shortcuts, connections, terminal. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setEditorSettingsOpen(true)}
                      >
                        <Settings2 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('files.editor_settings')}
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setShortcutsOpen(true)}
                      >
                        <Keyboard size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.shortcuts')}</TooltipContent>
                  </Tooltip>

                  {editorVisible && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={connectionsOpen ? 'secondary' : 'ghost'}
                          size="icon-xs"
                          onClick={() => setConnectionsOpen(true)}
                        >
                          <Plug size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('connections.title')}</TooltipContent>
                    </Tooltip>
                  )}

                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs">
                            <Terminal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>{t('files.terminal')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="gap-2" onSelect={() => { openTerminalTab('bash'); setEditorVisible(true) }}>
                        <Terminal size={14} className="text-muted-foreground" />
                        {t('files.terminal_bash')}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="gap-2" onSelect={() => { openTerminalTab('python'); setEditorVisible(true) }}>
                        <PythonLogo size={14} />
                        {t('files.terminal_python')}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="gap-2" onSelect={() => { openTerminalTab('r'); setEditorVisible(true) }}>
                        <RLogo size={14} />
                        {t('files.terminal_r')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={outputVisible ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={() => setOutputVisible(!outputVisible)}
                        disabled={!hasOutput}
                      >
                        {outputVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.toggle_output')}</TooltipContent>
                  </Tooltip>

                  {isNotebook && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={outlineVisible ? 'secondary' : 'ghost'}
                          size="icon-xs"
                          onClick={() => {
                            const next = !outlineVisible
                            setOutlineVisible(next)
                            localStorage.setItem('linkr-notebook-outline', String(next))
                          }}
                        >
                          <PanelRight size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('files.toggle_outline')}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>

              {/* Unified tab bar: file tabs (left) | separator | output tabs (right) */}
              {(openFileIds.length > 0 || terminalTabs.length > 0 || outputTabOrder.length > 0) && (
                <div className="flex items-center border-b bg-muted/30">
                  {/* File tabs */}
                  {openFileIds.length > 0 && (
                    <button
                      onClick={() => scrollTabs(fileTabScrollRef, 'left')}
                      disabled={!fileTabCanScrollLeft}
                      className={cn(
                        'shrink-0 px-0.5 py-1.5 transition-colors',
                        fileTabCanScrollLeft
                          ? 'text-muted-foreground hover:text-foreground'
                          : 'text-muted-foreground/25 cursor-default'
                      )}
                    >
                      <ChevronLeft size={12} />
                    </button>
                  )}
                  <div
                    ref={fileTabScrollRef}
                    className="flex items-center overflow-x-auto scrollbar-none"
                  >
                    {openFileIds.map((fid) => {
                      const node = nodes.find((n) => n.id === fid)
                      if (!node) return null
                      const isActive = fid === selectedFileId
                      const isVirtual = node.virtual === true
                      const isDirty = !isVirtual && _dirtyVersion >= 0 && isFileDirty(fid)
                      return (
                        <ContextMenu key={fid}>
                          <ContextMenuTrigger asChild>
                            <button
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('file-tab-id', fid)
                                e.dataTransfer.effectAllowed = 'move'
                                setDragFileId(fid)
                              }}
                              onDragOver={(e) => {
                                if (!e.dataTransfer.types.includes('file-tab-id')) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                const rect = e.currentTarget.getBoundingClientRect()
                                const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                                setDropFileInsert({ id: fid, side })
                              }}
                              onDragLeave={() => setDropFileInsert(null)}
                              onDrop={(e) => {
                                e.preventDefault()
                                const side = dropFileInsert?.side ?? 'right'
                                setDropFileInsert(null)
                                setDragFileId(null)
                                const draggedId = e.dataTransfer.getData('file-tab-id')
                                if (!draggedId || draggedId === fid) return
                                const fromIdx = openFileIds.indexOf(draggedId)
                                let toIdx = openFileIds.indexOf(fid)
                                if (side === 'right') toIdx++
                                if (fromIdx < toIdx) toIdx--
                                if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) reorderOpenFiles(fromIdx, toIdx)
                              }}
                              onDragEnd={() => { setDragFileId(null); setDropFileInsert(null) }}
                              onClick={() => {
                                selectFile(fid)
                                if (!editorVisible) setEditorVisible(true)
                              }}
                              className={cn(
                                'relative group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                isActive
                                  ? 'bg-background text-foreground'
                                  : 'text-muted-foreground hover:bg-accent/50',
                                dragFileId === fid && 'opacity-40',
                              )}
                            >
                              {dropFileInsert?.id === fid && dropFileInsert.side === 'left' && dragFileId !== fid && (
                                <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                              )}
                              {dropFileInsert?.id === fid && dropFileInsert.side === 'right' && dragFileId !== fid && (
                                <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                              )}
                              {isVirtual && <Lock size={10} className="text-muted-foreground/50" />}
                              <span className="max-w-[140px] truncate" title={node.name}>{node.name}</span>
                              {isDirty && (
                                <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-orange-400" />
                              )}
                              <span
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCloseFile(fid)
                                }}
                                className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                              >
                                <X size={10} />
                              </span>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => handleCloseFile(fid)}>
                              {t('files.close')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => handleCloseOtherFiles(fid)}>
                              {t('files.close_others')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleCloseAllFiles}>
                              {t('files.close_all')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                    {/* Terminal tabs (JupyterLab-style, full-width when active) */}
                    {terminalTabs.map((tt) => {
                      const isActive = tt.id === selectedFileId
                      return (
                        <button
                          key={tt.id}
                          onClick={() => {
                            selectTerminalTab(tt.id)
                            if (!editorVisible) setEditorVisible(true)
                          }}
                          className={cn(
                            'relative group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                            isActive ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                          )}
                        >
                          <Terminal size={11} className="text-muted-foreground/70" />
                          <span className="max-w-[140px] truncate" title={tt.label}>{tt.label}</span>
                          <span
                            onClick={(e) => { e.stopPropagation(); closeTerminalTab(tt.id) }}
                            className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                          >
                            <X size={10} />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {openFileIds.length > 0 && (
                    <button
                      onClick={() => scrollTabs(fileTabScrollRef, 'right')}
                      disabled={!fileTabCanScrollRight}
                      className={cn(
                        'shrink-0 px-0.5 py-1.5 transition-colors',
                        fileTabCanScrollRight
                          ? 'text-muted-foreground hover:text-foreground'
                          : 'text-muted-foreground/25 cursor-default'
                      )}
                    >
                      <ChevronRight size={12} />
                    </button>
                  )}

                  {/* Vertical separator between file tabs and output tabs */}
                  {openFileIds.length > 0 && outputTabOrder.length > 0 && (
                    <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                  )}

                  {/* Output tabs */}
                  {outputTabOrder.length > 0 && (
                    <button
                      onClick={() => scrollTabs(outputTabScrollRef, 'left')}
                      disabled={!outputTabCanScrollLeft}
                      className={cn(
                        'shrink-0 px-0.5 py-1.5 transition-colors',
                        outputTabCanScrollLeft
                          ? 'text-muted-foreground hover:text-foreground'
                          : 'text-muted-foreground/25 cursor-default'
                      )}
                    >
                      <ChevronLeft size={12} />
                    </button>
                  )}
                  <div
                    ref={outputTabScrollRef}
                    className="flex items-center overflow-x-auto scrollbar-none"
                  >
                    {outputTabOrder.map((tabId) => {
                      const isConsole = tabId === '__exec_console__'
                      const isActive = activeOutputTab === tabId

                      if (isConsole) {
                        return (
                          <ContextMenu key={tabId}>
                            <ContextMenuTrigger asChild>
                              <button
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('output-tab-id', tabId)
                                  e.dataTransfer.effectAllowed = 'move'
                                  setDragOutputTabId(tabId)
                                }}
                                onDragOver={(e) => {
                                  if (!e.dataTransfer.types.includes('output-tab-id')) return
                                  e.preventDefault()
                                  e.dataTransfer.dropEffect = 'move'
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                                  setDropOutputInsert({ id: tabId, side })
                                }}
                                onDragLeave={() => setDropOutputInsert(null)}
                                onDrop={(e) => {
                                  e.preventDefault()
                                  const side = dropOutputInsert?.side ?? 'right'
                                  setDropOutputInsert(null)
                                  setDragOutputTabId(null)
                                  const draggedId = e.dataTransfer.getData('output-tab-id')
                                  if (!draggedId || draggedId === tabId) return
                                  const fromIdx = outputTabOrder.indexOf(draggedId)
                                  let toIdx = outputTabOrder.indexOf(tabId)
                                  if (side === 'right') toIdx++
                                  if (fromIdx < toIdx) toIdx--
                                  if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) reorderAllOutputTabs(fromIdx, toIdx)
                                }}
                                onDragEnd={() => { setDragOutputTabId(null); setDropOutputInsert(null) }}
                                onClick={() => {
                                  setActiveOutputTab(tabId)
                                  if (!outputVisible) setOutputVisible(true)
                                }}
                                className={cn(
                                  'relative group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                  isActive && outputVisible
                                    ? 'bg-primary/10 text-foreground'
                                    : 'bg-primary/5 text-muted-foreground hover:bg-primary/10',
                                  dragOutputTabId === tabId && 'opacity-40',
                                )}
                              >
                                {dropOutputInsert?.id === tabId && dropOutputInsert.side === 'left' && dragOutputTabId !== tabId && (
                                  <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                                )}
                                {dropOutputInsert?.id === tabId && dropOutputInsert.side === 'right' && dragOutputTabId !== tabId && (
                                  <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                                )}
                                <span>{t('files.console')}</span>
                                <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                                  {executionResults.length}
                                </span>
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    clearExecutionResults()
                                  }}
                                  className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                                >
                                  <X size={10} />
                                </span>
                              </button>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem onClick={() => clearExecutionResults()}>
                                {t('files.close')}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={() => handleCloseOtherOutputTabs(tabId)}>
                                {t('files.close_others')}
                              </ContextMenuItem>
                              <ContextMenuItem onClick={handleCloseAllOutputTabs}>
                                {t('files.close_all')}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        )
                      }

                      const tab = outputTabs.find((ot) => ot.id === tabId)
                      if (!tab) return null

                      return (
                        <ContextMenu key={tab.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('output-tab-id', tab.id)
                                e.dataTransfer.effectAllowed = 'move'
                                setDragOutputTabId(tab.id)
                              }}
                              onDragOver={(e) => {
                                if (!e.dataTransfer.types.includes('output-tab-id')) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                const rect = e.currentTarget.getBoundingClientRect()
                                const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                                setDropOutputInsert({ id: tab.id, side })
                              }}
                              onDragLeave={() => setDropOutputInsert(null)}
                              onDrop={(e) => {
                                e.preventDefault()
                                const side = dropOutputInsert?.side ?? 'right'
                                setDropOutputInsert(null)
                                setDragOutputTabId(null)
                                const draggedId = e.dataTransfer.getData('output-tab-id')
                                if (!draggedId || draggedId === tab.id) return
                                const fromIdx = outputTabOrder.indexOf(draggedId)
                                let toIdx = outputTabOrder.indexOf(tab.id)
                                if (side === 'right') toIdx++
                                if (fromIdx < toIdx) toIdx--
                                if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) reorderAllOutputTabs(fromIdx, toIdx)
                              }}
                              onDragEnd={() => { setDragOutputTabId(null); setDropOutputInsert(null) }}
                              onClick={() => {
                                setActiveOutputTab(tab.id)
                                if (!outputVisible) setOutputVisible(true)
                              }}
                              className={cn(
                                'relative group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                tab.id === activeOutputTab && outputVisible
                                  ? 'bg-primary/10 text-foreground'
                                  : 'bg-primary/5 text-muted-foreground hover:bg-primary/10',
                                dragOutputTabId === tab.id && 'opacity-40',
                              )}
                            >
                              {dropOutputInsert?.id === tab.id && dropOutputInsert.side === 'left' && dragOutputTabId !== tab.id && (
                                <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                              )}
                              {dropOutputInsert?.id === tab.id && dropOutputInsert.side === 'right' && dragOutputTabId !== tab.id && (
                                <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                              )}
                              {getTabIcon(tab.type)}
                              <span className="max-w-[120px] truncate" title={tab.label}>{tab.label}</span>
                              <span
                                onClick={(e) => {
                                  e.stopPropagation()
                                  closeOutputTab(tab.id)
                                }}
                                className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                              >
                                <X size={10} />
                              </span>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => closeOutputTab(tab.id)}>
                              {t('files.close')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => handleCloseOtherOutputTabs(tab.id)}>
                              {t('files.close_others')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={handleCloseAllOutputTabs}>
                              {t('files.close_all')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                  </div>
                  {outputTabOrder.length > 0 && (
                    <button
                      onClick={() => scrollTabs(outputTabScrollRef, 'right')}
                      disabled={!outputTabCanScrollRight}
                      className={cn(
                        'shrink-0 px-0.5 py-1.5 transition-colors',
                        outputTabCanScrollRight
                          ? 'text-muted-foreground hover:text-foreground'
                          : 'text-muted-foreground/25 cursor-default'
                      )}
                    >
                      <ChevronRight size={12} />
                    </button>
                  )}
                </div>
              )}

              {/* Editor + Output + Terminal */}
              <div className="flex-1 overflow-hidden">
                <Allotment vertical>
                  {/* Top: editor + output (horizontal split) */}
                  <Allotment.Pane>
                    <Allotment>
                      {/* Editor panel — notebooks are kept alive (hidden when inactive).
                          Also visible when a terminal tab is active (terminals live in
                          this pane). */}
                      <Allotment.Pane minSize={150} visible={editorVisible || !!activeTerminalTab}>
                        {/* Keep-alive notebooks: render ALL open notebook files, hide inactive ones */}
                        {openFileIds.map((fid) => {
                          const node = nodes.find((n) => n.id === fid)
                          if (!node) return null
                          const isIpynb = node.name.endsWith('.ipynb')
                          const isRmd = /\.(rmd|qmd)$/i.test(node.name)
                          if (!isIpynb && !isRmd) return null
                          const isActive = fid === selectedFileId
                          const isVirtual = node.virtual === true
                          return (
                            <div
                              key={fid}
                              className="h-full w-full"
                              style={{ display: isActive ? 'block' : 'none' }}
                            >
                              <Suspense fallback={
                                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                                  Loading notebook...
                                </div>
                              }>
                                {isIpynb ? (
                                  <LazyIpynbNotebook
                                    ref={makeNotebookRef(fid)}
                                    content={node.content ?? ''}
                                    onChange={isVirtual ? undefined : (v) =>
                                      updateFileContent(node.id, v)
                                    }
                                    readOnly={isVirtual}
                                    onSave={handleSaveFile}
                                    onRenderOutput={(html, title) => {
                                      addOutputTab({
                                        id: `render-${fid}`,
                                        label: `Render — ${title}`,
                                        type: 'html',
                                        content: html,
                                      })
                                      setOutputVisible(true)
                                    }}
                                    activeConnectionId={activeConnectionId}
                                    fileName={node.name}
                                  />
                                ) : (
                                  <LazyRmdNotebook
                                    ref={makeNotebookRef(fid)}
                                    content={node.content ?? ''}
                                    onChange={isVirtual ? undefined : (v) =>
                                      updateFileContent(node.id, v)
                                    }
                                    readOnly={isVirtual}
                                    onSave={handleSaveFile}
                                    onRenderOutput={(html, title) => {
                                      addOutputTab({
                                        id: `render-${fid}`,
                                        label: `Render — ${title}`,
                                        type: 'html',
                                        content: html,
                                      })
                                      setOutputVisible(true)
                                    }}
                                    activeConnectionId={activeConnectionId}
                                  />
                                )}
                              </Suspense>
                            </div>
                          )
                        })}

                        {/* Non-notebook files: standard CodeEditor (only the selected one) */}
                        {selectedNode && !isIpynbFile && !isRmdNotebook && (
                          <CodeEditor
                            key={`${selectedFileId}-${shortcutVersion}`}
                            value={selectedNode.content ?? ''}
                            language={selectedNode.language ?? 'plaintext'}
                            onChange={isVirtualFile ? undefined : (v) =>
                              updateFileContent(selectedNode.id, v ?? '')
                            }
                            readOnly={isVirtualFile}
                            editorRef={editorRef}
                            onSave={handleSaveFile}
                            onRunSelectionOrLine={isVirtualFile ? undefined : handleRunSelectionOrLine}
                            onRunFile={isVirtualFile ? undefined : handleRunFile}
                          />
                        )}

                        {/* All terminals stay mounted (hidden when inactive) so a
                            bash shell / REPL keeps its scrollback and connection
                            across tab switches. TerminalPanel re-fits itself when
                            it becomes visible again (a hidden xterm has zero size). */}
                        {terminalTabs.map((tt) => (
                          <div
                            key={tt.id}
                            className="h-full"
                            style={{ display: tt.id === selectedFileId ? 'block' : 'none' }}
                          >
                            <TerminalPanel
                              terminalType={tt.kind}
                              projectUid={activeProjectUid ?? undefined}
                              envId={activeSessionId}
                              active={tt.id === selectedFileId}
                            />
                          </div>
                        ))}

                        {/* Empty state */}
                        {!selectedNode && !activeTerminalTab && (
                          <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                              <FileCode
                                size={32}
                                className="mx-auto text-muted-foreground/50"
                              />
                              <p className="mt-3 text-sm text-muted-foreground">
                                {t('files.select_file')}
                              </p>
                            </div>
                          </div>
                        )}
                      </Allotment.Pane>

                      {/* Notebook outline sidebar */}
                      <Allotment.Pane
                        preferredSize={180}
                        minSize={120}
                        maxSize={300}
                        visible={outlineVisible && isNotebook}
                      >
                        <div className="h-full border-l bg-muted/20 overflow-y-auto">
                          <div className="px-2 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b">
                            {t('files.outline')}
                          </div>
                          <div className="py-1">
                            {outlineCells.map((cell, idx) => {
                              const state = outlineCellStates.get(cell.id)
                              const label = cell.type === 'yaml'
                                ? 'YAML'
                                : cell.type === 'markdown'
                                  ? `Markdown ${idx + 1}`
                                  : cell.chunkLabel || `${(cell.language ?? 'r').toUpperCase()} ${idx + 1}`
                              return (
                                <button
                                  key={cell.id}
                                  onClick={() => notebookRef.current?.scrollToCell(cell.id)}
                                  className="flex items-center gap-1.5 w-full px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-left"
                                >
                                  {cell.type === 'code' && state?.status === 'success' && (
                                    <Check size={10} className="text-green-500 shrink-0" />
                                  )}
                                  {cell.type === 'code' && state?.status === 'error' && (
                                    <XCircle size={10} className="text-red-500 shrink-0" />
                                  )}
                                  {cell.type === 'code' && state?.status === 'running' && (
                                    <Loader2 size={10} className="animate-spin text-blue-500 shrink-0" />
                                  )}
                                  {cell.type === 'code' && !state?.status && (
                                    <div className="w-2.5 h-2.5 rounded-full border border-muted-foreground/30 shrink-0" />
                                  )}
                                  {cell.type !== 'code' && (
                                    <FileText size={10} className="text-muted-foreground/50 shrink-0" />
                                  )}
                                  <span className="truncate">{label}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </Allotment.Pane>

                      {/* Output panel */}
                      <Allotment.Pane
                        minSize={200}
                        visible={outputVisible && hasOutput}
                      >
                        <div className="h-full border-l">
                          <OutputPanel
                            onClose={() => setOutputVisible(false)}
                            hideTabBar
                          />
                        </div>
                      </Allotment.Pane>
                    </Allotment>
                  </Allotment.Pane>
                </Allotment>
              </div>
            </div>
          </Allotment.Pane>
        </Allotment>

        <CreateFileDialog
          open={createFileOpen}
          onOpenChange={setCreateFileOpen}
          parentId={createParentId}
        />
        <CreateFolderDialog
          open={createFolderOpen}
          onOpenChange={setCreateFolderOpen}
          parentId={createParentId}
        />
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          parentId={null}
        />
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
        />
        {activeConnectionId && (
          <SchemaBrowserDialog
            open={schemaDialogOpen}
            onOpenChange={setSchemaDialogOpen}
            dataSourceId={activeConnectionId}
          />
        )}
        <EditorSettingsDialog
          open={editorSettingsOpen}
          onOpenChange={setEditorSettingsOpen}
        />
        {activeProjectUid && (
          <ConnectionsPanel
            open={connectionsOpen}
            onOpenChange={setConnectionsOpen}
            projectUid={activeProjectUid}
          />
        )}

        {/* Unsaved changes confirmation dialog */}
        <Dialog open={!!closeConfirmFileId} onOpenChange={(open) => { if (!open) setCloseConfirmFileId(null) }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('files.unsaved_changes_title')}</DialogTitle>
              <DialogDescription>
                {t('files.unsaved_changes_description', {
                  name: nodes.find((n) => n.id === closeConfirmFileId)?.name ?? '',
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="sm:justify-between">
              <Button variant="outline" onClick={() => setCloseConfirmFileId(null)}>
                {t('common.cancel')}
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={handleDiscardAndClose}>
                  {t('files.dont_save')}
                </Button>
                <Button onClick={handleSaveAndClose}>
                  {t('common.save')}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
