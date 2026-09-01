import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type * as Monaco from 'monaco-editor'
import {
  FileCode,
  FilePlus,
  FolderPlus,
  Upload,
  PanelLeft,
  Terminal,
  Settings2,
  Keyboard,
  Info,
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
  CornerDownLeft,
  StepForward,
  ListEnd,
  FileCode2,
  Database,
  Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { TabGroupSplitter, useTabGroupSplit } from '@/components/editor/TabGroupSplitter'
import { CodeEditor, type PendingEdits } from '@/components/editor/CodeEditor'
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
import { streamOnServer, runFileAsJob } from '@/lib/api/execution'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { queryDatasetRows } from '@/lib/api/datasets'
import { executePython } from '@/lib/runtimes/pyodide-engine'
import { executeR } from '@/lib/runtimes/webr-engine'
import { isImperativeInstall, extractInstallPackages } from '@/lib/runtimes/install-detect'
import { FileTree } from './files/FileTree'
import { FolderPathBar } from './files/FolderPathBar'
import { OutputPanel, getTabIcon } from './files/OutputPanel'
import { CreateFileDialog } from './files/CreateFileDialog'
import { CreateFolderDialog } from './files/CreateFolderDialog'
import { UploadDialog } from './files/UploadDialog'
import { RunButton } from './files/RunButton'
import { SessionDropdown } from '@/components/execution/SessionDropdown'
import { PythonLogo, RLogo } from '@/components/ui/language-icon'
import { SectionLabel } from '@/components/ui/section-label'
import {
  SidebarSearchField,
  SidebarSearchToggle,
  useSidebarSearch,
} from '@/components/SidebarSearch'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { useSessionStore } from '@/stores/session-store'
import { KeyboardShortcutsDialog } from './files/KeyboardShortcutsDialog'
import { DocumentationDialog } from './files/DocumentationDialog'
import { SchemaBrowserDialog } from '@/features/warehouse/databases/SchemaBrowserDialog'
import { EditorSettingsDialog } from './files/EditorSettingsDialog'
import { ConnectionsPanel } from './files/ConnectionsPanel'
import { ConnectionDropdown } from './files/ConnectionDropdown'
import { useGlobalShortcuts, type ShortcutHandlers } from '@/hooks/use-shortcuts'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { useShortcutStore } from '@/stores/shortcut-store'
import { comboToString } from '@/lib/format-shortcut'
import { widenToBlock, nextRunnableLine, firstRunnableLine, bracketProbeColumn, opensBlockAtEol, type RunSpan } from '@/lib/editor-run-block'
import type { ShortcutActionId } from '@/types/shortcuts'

const LazyRmdNotebook = lazy(() => import('./files/RmdNotebook').then(m => ({ default: m.RmdNotebook })))
const LazyIpynbNotebook = lazy(() => import('./files/IpynbNotebook').then(m => ({ default: m.IpynbNotebook })))
import type { RmdNotebookHandle, CellState } from './files/RmdNotebook'
import type { RmdCell } from '@/lib/rmd-parser'
import type { IpynbNotebookHandle } from './files/IpynbNotebook'

export function FilesPage() {
  const { t } = useTranslation()
  // Atomic selectors, NOT `useFileStore()`. Subscribing to the whole store re-rendered
  // this 2000-line page on every mutation of any field — including `files`, which is
  // rebuilt on every keystroke, which in turn re-ran the Monaco decoration effects
  // below over the entire file. Actions are stable references, so selecting them one
  // by one costs nothing.
  const selectedFileId = useFileStore((s) => s.selectedFileId)
  const openFileIds = useFileStore((s) => s.openFileIds)
  const outputTabs = useFileStore((s) => s.outputTabs)
  const outputTabOrder = useFileStore((s) => s.outputTabOrder)
  const activeOutputTab = useFileStore((s) => s.activeOutputTab)
  const executionResults = useFileStore((s) => s.executionResults)
  const outputVisible = useFileStore((s) => s.outputVisible)
  const terminalTabs = useFileStore((s) => s.terminalTabs)
  const editorModeFileIds = useFileStore((s) => s.editorModeFileIds)
  const _dirtyVersion = useFileStore((s) => s._dirtyVersion)

  const updateFileContent = useFileStore((s) => s.updateFileContent)
  const selectFile = useFileStore((s) => s.selectFile)
  const closeFile = useFileStore((s) => s.closeFile)
  const reorderOpenFiles = useFileStore((s) => s.reorderOpenFiles)
  const addExecutionResult = useFileStore((s) => s.addExecutionResult)
  const updateExecutionResult = useFileStore((s) => s.updateExecutionResult)
  const addOutputTab = useFileStore((s) => s.addOutputTab)
  const setActiveOutputTab = useFileStore((s) => s.setActiveOutputTab)
  const closeOutputTab = useFileStore((s) => s.closeOutputTab)
  const reorderAllOutputTabs = useFileStore((s) => s.reorderAllOutputTabs)
  const clearExecutionResults = useFileStore((s) => s.clearExecutionResults)
  const setOutputVisible = useFileStore((s) => s.setOutputVisible)
  const openTerminalTab = useFileStore((s) => s.openTerminalTab)
  const closeTerminalTab = useFileStore((s) => s.closeTerminalTab)
  const selectTerminalTab = useFileStore((s) => s.selectTerminalTab)
  const loadProjectFiles = useFileStore((s) => s.loadProjectFiles)
  const reloadFromDisk = useFileStore((s) => s.reloadFromDisk)
  const isFileDirty = useFileStore((s) => s.isFileDirty)
  const saveFile = useFileStore((s) => s.saveFile)
  const revertFile = useFileStore((s) => s.revertFile)
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const canWriteIde = useMyProjectRole(activeProjectUid ?? undefined).can('ide:write')
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const loadProjectConnections = useConnectionStore((s) => s.loadProjectConnections)
  const isExecuting = useRuntimeStore((s) => s.isExecuting)
  const startExecution = useRuntimeStore((s) => s.startExecution)
  const stopExecution = useRuntimeStore((s) => s.stopExecution)
  const finishExecution = useRuntimeStore((s) => s.finishExecution)
  const loadDataSources = useDataSourceStore((s) => s.loadDataSources)
  const mountProjectSources = useDataSourceStore((s) => s.mountProjectSources)
  const loadCohorts = useCohortStore((s) => s.loadCohorts)
  const loadPipelines = usePipelineStore((s) => s.loadPipelines)
  const loadProjectDatasets = useDatasetStore((s) => s.loadProjectDatasets)
  const loadFileData = useDatasetStore((s) => s.loadFileData)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const datasetFiles = useDatasetStore((s) => s.files)
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
  const [docsOpen, setDocsOpen] = useState(false)
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false)
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const fileSearch = useSidebarSearch()
  const [editorVisible, setEditorVisible] = useState(true)
  const [dragFileId, setDragFileId] = useState<string | null>(null)
  const [dropFileInsert, setDropFileInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [dragOutputTabId, setDragOutputTabId] = useState<string | null>(null)
  const [dropOutputInsert, setDropOutputInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)

  // --- Tab scroll with arrows (file tabs) ---
  // How the file and output tab groups share the bar's width.
  const tabSplit = useTabGroupSplit('ide')
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

  // Load connections, files, and other stores when the project changes. Re-scan
  // files when the ide_path binding changes (same project → new folder); the store
  // compares the binding against its last scan, so this survives remounts too.
  useEffect(() => {
    if (activeProjectUid) {
      loadProjectConnections(activeProjectUid)
      loadProjectFiles(activeProjectUid, idePath ?? undefined)
      // Mount the project's databases the way the Databases page does. Without
      // it the IDE showed whatever status was last written — a database imported
      // without data stayed grey here while the Databases page had already
      // healed it by mounting. No-ops in server mode and for already-mounted
      // sources. Sequenced after the load: it reads the rows that load fetches.
      loadDataSources().then(() => mountProjectSources(activeProjectUid))
      loadCohorts()
      loadPipelines()
      loadProjectDatasets(activeProjectUid)
    }
  }, [activeProjectUid, idePath, loadProjectConnections, loadProjectFiles, loadDataSources, mountProjectSources, loadCohorts, loadPipelines, loadProjectDatasets])

  // Auto-selection lives in ConnectionDropdown, which also re-selects when the
  // active id belongs to another project (the selection is global). Doing it
  // here too would fight it: this effect only fired when nothing was selected,
  // so a stale cross-project id was left in place.

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  // Typing is debounced in CodeEditor, so the toolbar's Save/Run must settle the
  // buffer before reading the file's content from the store.
  const pendingEditsRef = useRef<PendingEdits | null>(null)
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
  // Scalar views of the selected file. Effects key on THESE, never on `nodes` or
  // `selectedNode` — both get a new identity on every keystroke in any file, which
  // re-ran the CSV parsing/decoration effects over the whole document each time.
  // Non-null exactly when a file (not a folder) is selected.
  const selectedName = selectedNode?.type === 'file' ? selectedNode.name : null
  const selectedContent = selectedNode?.type === 'file' ? selectedNode.content ?? '' : null
  const activeTerminalTab = terminalTabs.find((t) => t.id === selectedFileId)
  // Sessions are language-scoped: resolve the active session for the language
  // of what's in focus. A script uses its own language; an R/Python terminal
  // uses its kind. Subscribe to activeByScope so the id updates on selection.
  const activeByScope = useSessionStore((s) => s.activeByScope)
  const sessionLanguage: 'python' | 'r' | undefined =
    activeTerminalTab && (activeTerminalTab.kind === 'python' || activeTerminalTab.kind === 'r')
      ? activeTerminalTab.kind
      : selectedNode?.language === 'python' || selectedNode?.language === 'r'
        ? selectedNode.language
        : undefined
  const activeSessionId =
    activeProjectUid && sessionLanguage
      ? activeByScope[`${activeProjectUid}:${sessionLanguage}`] ?? 'default'
      : 'default'
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

  // Outline: the notebook PUSHES its cells + states (see RmdNotebook's
  // onOutlineChange). Polling the imperative handle twice a second re-rendered this
  // whole page on every tick, whether or not anything had changed.
  const [outlineCells, setOutlineCells] = useState<RmdCell[]>([])
  const [outlineCellStates, setOutlineCellStates] = useState<Map<string, CellState>>(new Map())

  // Every open notebook stays mounted (hidden tabs), so each one pushes; only the
  // selected file's push may reach the sidebar, which shows one outline.
  const handleOutlineChange = useCallback(
    (fid: string, cells: RmdCell[], states: Map<string, CellState>) => {
      if (fid !== selectedFileIdRef.current) return
      setOutlineCells(cells)
      setOutlineCellStates(states)
    },
    [],
  )

  // Switching tabs shows a different notebook: clear until that one pushes, so the
  // sidebar never shows the previous file's outline.
  useEffect(() => {
    setOutlineCells([])
    setOutlineCellStates(new Map())
  }, [selectedFileId])

  // Whether the SELECTED notebook is running — drives Run ⇄ Stop in the toolbar.
  // Pushed for the same reason as the outline: the toolbar reads the notebook
  // through a ref, so nothing would re-render it when a run starts or ends.
  const [notebookRunning, setNotebookRunning] = useState(false)
  const handleNotebookRunningChange = useCallback((fid: string, running: boolean) => {
    if (fid !== selectedFileIdRef.current) return
    setNotebookRunning(running)
  }, [])

  // A background notebook may still be running, but the toolbar describes the
  // selected one — reset until it pushes its own state.
  useEffect(() => { setNotebookRunning(false) }, [selectedFileId])

  // When a dataset file is selected, redirect it to an output tab (the dataset
  // viewer) instead of a file tab showing raw JSON. Matches both the legacy
  // bridge id and the read-only IDE-tree node id (virtual:datasets/node/<id>).
  useEffect(() => {
    const DS_NODE_PREFIX = 'virtual:datasets/node/'
    const isBridgeId = selectedFileId?.startsWith('ds-bridge:')
    const isDsNodeId = selectedFileId?.startsWith(DS_NODE_PREFIX)
    if (!isBridgeId && !isDsNodeId) return
    // `selectedName` is non-null exactly when the selected node is a file — deriving
    // the guard from it keeps this effect off `nodes`, whose identity churns on
    // every keystroke.
    if (selectedName === null) return

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
  }, [selectedFileId, selectedName, datasetFiles, closeFile, loadFileData, getFileRows, addOutputTab, setOutputVisible, setEditorVisible])

  // When a CSV/TSV IDE file is selected, open it as a table in the output panel
  // (skip if the file was explicitly opened in editor mode via context menu)
  useEffect(() => {
    if (!selectedFileId || selectedFileId.startsWith('ds-bridge:') || selectedFileId.startsWith('virtual:')) return
    if (editorModeFileIds.has(selectedFileId)) return
    if (selectedName === null || selectedContent === null) return
    const ext = selectedName.split('.').pop()?.toLowerCase()
    if (ext !== 'csv' && ext !== 'tsv') return
    const content = selectedContent
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
      label: selectedName,
      type: 'table',
      content: { headers, rows: tableRows },
    })
    setOutputVisible(true)
  }, [selectedFileId, selectedName, selectedContent, addOutputTab, setOutputVisible, editorModeFileIds])

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

  // CSV column colorization in Monaco — apply inline decorations per column.
  const csvDecorationsRef = useRef<string[]>([])
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !selectedFileId) {
      csvDecorationsRef.current = []
      return
    }
    if (selectedName === null || selectedContent === null) return
    const ext = selectedName.split('.').pop()?.toLowerCase()
    if (ext !== 'csv' && ext !== 'tsv') {
      if (csvDecorationsRef.current.length > 0) {
        csvDecorationsRef.current = editor.deltaDecorations(csvDecorationsRef.current, [])
      }
      return
    }
    const content = selectedContent
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
  }, [selectedFileId, selectedName, selectedContent])

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
        running: true,
      })

      const addFiguresAndTable = (result: RuntimeOutput) => {
        for (const fig of result.figures) {
          addOutputTab({ id: fig.id, label: `${fig.label} — ${fileName}`, type: 'figure', content: fig.data })
          setActiveOutputTab(fig.id)
        }
        if (result.table) {
          // Focused like a figure or a widget: the console has already printed
          // the frame as text, so leaving the panel there hides the very table
          // that was just built.
          const id = `table-${Date.now()}`
          addOutputTab({ id, label: `Result — ${fileName}`, type: 'table', content: result.table })
          setActiveOutputTab(id)
        }
        // A rich HTML widget (plotly / leaflet / DT…) → its own tab (iframe).
        if (result.html) {
          const id = `html-${Date.now()}`
          addOutputTab({ id, label: `Widget — ${fileName}`, type: 'html', content: result.html })
          setActiveOutputTab(id)
        }
      }

      const controller = startExecution()
      try {
        // Server mode: STREAM over the kernel WebSocket so output appears line by
        // line as it's produced (a long Sys.sleep between prints shows the pause),
        // instead of the whole block arriving at once. Front-only keeps the WASM
        // runtimes. The active connection is threaded so sql_query() still works.
        if (isServerMode()) {
          // Installing packages from a run script bypasses the declarative env
          // (manifest + lockfile the Environments manager edits): the package
          // lands in the library but not the lockfile, so it's wiped on the next
          // build. Prefix the same warning the terminal shows, and — when we can
          // parse the package names — offer a one-click declarative install.
          const isInstall = isImperativeInstall(language, code)
          const warning = isInstall ? `\x1b[31m${t('terminal.installWarning')}\x1b[0m\n\n` : ''
          const offerPkgs = isInstall ? extractInstallPackages(language, code) : []
          const installOffer = offerPkgs.length ? { language, packages: offerPkgs } : undefined
          let streamed = ''
          // Stream mode delivers the text through onChunk and leaves the done
          // payload's stdout/stderr empty, so `!result.stderr` would call every
          // run a success. Track whether anything arrived on stderr instead.
          let sawStderr = false
          // The kernel emits one chunk per line, so `print(df)` on a 1000-row frame
          // arrives as 1000 chunks. Pushing each one to the store re-rendered the page
          // 1000 times and re-sent the whole accumulated string every time. Coalesce
          // into one store write per animation frame: the text still appears as it is
          // produced, at a rate a screen can actually show.
          let flushHandle: number | null = null
          const flush = () => {
            flushHandle = null
            updateExecutionResult(execId, { output: warning + streamed })
          }
          // Settle the pending frame by RUNNING it, not cancelling it: Stop throws
          // AbortError and that handler keeps the output it finds on the result, so a
          // dropped frame would silently lose the last lines the user did receive.
          const flushNow = () => {
            if (flushHandle === null) return
            cancelAnimationFrame(flushHandle)
            flush()
          }
          let result
          try {
            result = await streamOnServer(language, code, {
              projectUid: activeProjectUid ?? undefined,
              connectionId: activeConnectionId ?? undefined,
              signal: controller.signal,
              onChunk: (text, kind) => {
                if (kind === 'stderr') sawStderr = true
                streamed += text
                if (flushHandle === null) flushHandle = requestAnimationFrame(flush)
              },
            })
          } finally {
            flushNow()
          }
          const duration = Date.now() - start
          updateExecutionResult(execId, {
            duration,
            // Red vs amber comes from the kernel's own verdict, not from stderr:
            // R writes warnings, messages AND errors there, so stderr alone cannot
            // tell "it ran but warned" (amber) from "it raised" (red).
            success: !result.failed,
            warned: !result.failed && (sawStderr || !!result.stderr),
            output: warning + (streamed || `Executed in ${duration}ms`),
            installOffer,
          })
          addFiguresAndTable(result)
          return
        }

        const result = language === 'python'
          ? await executePython(code, activeConnectionId, controller.signal)
          : await executeR(code, activeConnectionId, controller.signal)

        const duration = Date.now() - start
        const failed = result.failed === true
        updateExecutionResult(execId, {
          duration,
          success: !failed,
          // Warnings reach stderr without failing the run, so show them next to the
          // output rather than instead of it.
          warned: !failed && !!result.stderr,
          output: failed
            ? result.stderr
            : [result.stdout, result.stderr].filter(Boolean).join('\n') || `Executed in ${duration}ms`,
        })
        addFiguresAndTable(result)
      } catch (err) {
        const duration = Date.now() - start
        // A user Stop aborts the stream — keep whatever output already arrived
        // instead of replacing it with an error message. Closing the socket is what
        // SIGINTs the kernel (the server interrupts on WS teardown), so there is no
        // separate interrupt call here.
        if (err instanceof DOMException && err.name === 'AbortError') {
          updateExecutionResult(execId, { duration, success: false, interrupted: true })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          updateExecutionResult(execId, {
            duration,
            success: false,
            output: message,
          })
        }
      } finally {
        // Clear the activity indicator on every exit path (done / error / stop).
        updateExecutionResult(execId, { running: false })
        finishExecution()
      }
    },
    [activeConnectionId, activeProjectUid, t, startExecution, finishExecution, addExecutionResult, updateExecutionResult, addOutputTab, setActiveOutputTab]
  )

  // Stop: abort the run. In server mode, aborting closes the kernel WebSocket,
  // and the server's socket-teardown SIGINTs the kernel AND drains its stdout to
  // the done payload before the kernel goes idle — so a long run (Sys.sleep)
  // actually stops and no leftover output bleeds into the next run. We must NOT
  // also fire the separate /execute/interrupt HTTP route here: a second SIGINT
  // can land on the now-idle kernel and get queued into the following run.
  const handleStop = useCallback(() => {
    stopExecution()
  }, [stopExecution])

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
        return
      }
      // One run at a time: while a script is executing, ignore further run
      // triggers (button is already Stop, but the keyboard shortcuts must be
      // blocked too — otherwise Cmd+Enter would queue overlapping runs). Read the
      // LIVE store, not the render-time `isExecuting` closure: two rapid presses
      // before React commits the state would both see the stale `false`.
      if (useRuntimeStore.getState().isExecuting) return
      if (isSql && activeConnectionId) {
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
    // Reads the content from the store, so the debounced keystrokes have to land
    // first — otherwise this runs the file as it was up to 400ms ago.
    pendingEditsRef.current?.flush()
    const content = useFileStore.getState().files.find((f) => f.id === selectedNode?.id)?.content
    if (!selectedNode || !content) return
    runCode(content, selectedNode.name)
  }, [selectedNode, runCode])

  // Run the whole file as a background job (batch, fresh process). Server-only;
  // the RunButton hides the menu item off server mode. Fire-and-forget: the jobs
  // panel takes over from here (progress, output, cancel, figures/table). A pending
  // result card confirms it started and points to the jobs panel.
  const handleRunFileAsJob = useCallback(() => {
    // See handleRunFile: the content comes from the store, so settle the buffer.
    pendingEditsRef.current?.flush()
    const content = useFileStore.getState().files.find((f) => f.id === selectedNode?.id)?.content
    if (!selectedNode || !content) return
    if (selectedLanguage !== 'python' && selectedLanguage !== 'r') return
    const execId = `run-job-${Date.now()}`
    addExecutionResult({
      id: execId,
      fileName: selectedNode.name,
      language: selectedLanguage,
      timestamp: Date.now(),
      duration: 0,
      success: true,
      output: t('files.run_as_job_started', { label: selectedNode.name }),
      code: content,
    })
    setOutputVisible(true)
    void runFileAsJob(selectedLanguage, content, {
      projectUid: activeProjectUid ?? undefined,
      label: selectedNode.name,
    }).catch((e) =>
      updateExecutionResult(execId, {
        success: false,
        output: e instanceof Error ? e.message : String(e),
      })
    )
  }, [selectedNode, selectedLanguage, activeProjectUid, t, addExecutionResult, updateExecutionResult, setOutputVisible])

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

  /**
   * The block under the cursor, via Monaco's own "expand selection".
   *
   * Expanding repeatedly walks outward (word → call → block → … → whole file),
   * so we collect the steps and let widenToBlock pick the innermost multi-line
   * one. Its bracket provider starts a `xxx {` range at the line's first
   * non-whitespace character, so `f <- function() {` comes along with its body.
   *
   * We stop at the first multi-line range that is NOT the whole document: the
   * word provider always contributes the full model range, so breaking on any
   * multi-line range would accept "the entire script" on a line that has no
   * enclosing bracket.
   *
   * The editor's selection is restored before returning: this is a query, and
   * running a line must not leave the user's block highlighted.
   */
  const blockSpanAtCursor = useCallback(async (cursorLine: number, cursorColumn: number): Promise<RunSpan> => {
    const editor = editorRef.current
    if (!editor) return { startLine: cursorLine, endLine: cursorLine }
    const model = editor.getModel()
    const original = editor.getSelection()
    const expand = editor.getAction('editor.action.smartSelect.expand')
    if (!expand || !original || !model) return { startLine: cursorLine, endLine: cursorLine }
    const lineCount = model.getLineCount()

    // A line that ENDS by opening a block is not itself inside that block, and
    // Monaco only reports a pair whose closer is unmatched from the probe — so
    // probe one line down, from within the block.
    const opensBlock = opensBlockAtEol(model.getLineContent(cursorLine))
    const probeLine = opensBlock && cursorLine < lineCount ? cursorLine + 1 : cursorLine

    const candidates: RunSpan[] = []
    try {
      // Probe from ON the line's last non-blank character, never past it: the
      // bracket provider scans rightwards first, so a caret sitting after a
      // closing `}` finds no bracket and reports no block.
      const probeText = model.getLineContent(probeLine)
      const probeColumn = probeLine === cursorLine
        ? bracketProbeColumn(probeText, cursorColumn)
        : bracketProbeColumn(probeText, model.getLineMaxColumn(probeLine))
      editor.setSelection({
        startLineNumber: probeLine, startColumn: probeColumn,
        endLineNumber: probeLine, endColumn: probeColumn,
      })
      // Bounded: expansion terminates at the whole document, and a handful of
      // steps is enough to leave the current line in any real code.
      for (let step = 0; step < 8; step++) {
        // Genuinely async — the providers are awaited and the bracket one yields
        // to the event loop, so the selection is NOT updated until this resolves.
        await expand.run()
        const next = editor.getSelection()
        if (!next) break
        const span = { startLine: next.startLineNumber, endLine: next.endLineNumber }
        candidates.push(span)
        const wholeDocument = span.startLine <= 1 && span.endLine >= lineCount
        if (wholeDocument) break
        if (span.endLine > span.startLine) break
      }
    } finally {
      editor.setSelection(original)
    }
    // Match candidates against the line we probed from — when that was the line
    // below (a block-opening line), the block found starts at cursorLine anyway,
    // so the span still covers the caret.
    const span = widenToBlock(probeLine, candidates, lineCount)
    return span.startLine <= cursorLine && span.endLine >= cursorLine
      ? span
      : { startLine: cursorLine, endLine: cursorLine }
  }, [])

  const handleRunLine = useCallback(async () => {
    if (!editorRef.current || !selectedNode) return
    const position = editorRef.current.getPosition()
    if (!position) return
    const model = editorRef.current.getModel()
    if (!model) return

    // A comment is not a statement: run the next real line instead of sending
    // `# ...` to the interpreter. If that line opens a block, widening below
    // picks up the whole block from there.
    const startLine = firstRunnableLine(
      position.lineNumber,
      model.getLineCount(),
      (line) => model.getLineContent(line),
      selectedLanguage,
    )
    if (startLine === null) return
    // Only keep the caret's column when we are still on its own line; after
    // skipping down to a later line that column is meaningless.
    const startColumn = startLine === position.lineNumber
      ? position.column
      : model.getLineMaxColumn(startLine)

    // A cursor inside a multi-line block runs the WHOLE block: the single line
    // under it (`  warning("...")`, or a bare `}`) is rarely valid on its own.
    const span = await blockSpanAtCursor(startLine, startColumn)
    const code = model.getValueInRange({
      startLineNumber: span.startLine,
      startColumn: 1,
      endLineNumber: span.endLine,
      endColumn: model.getLineMaxColumn(span.endLine),
    })
    if (!code.trim()) return

    const label = span.startLine === span.endLine
      ? `${selectedNode.name}:${span.startLine}`
      : `${selectedNode.name}:${span.startLine}-${span.endLine}`
    runCode(code, label)

    // Advance past what just ran, so repeated presses walk down the file
    // (RStudio's behaviour). Nothing below → leave the cursor where it is.
    const nextLine = nextRunnableLine(
      span.endLine,
      model.getLineCount(),
      (line) => model.getLineContent(line),
      selectedLanguage,
    )
    if (nextLine !== null) {
      editorRef.current.setPosition({ lineNumber: nextLine, column: 1 })
      editorRef.current.revealLineInCenterIfOutsideViewport(nextLine)
    }
  }, [selectedNode, runCode, blockSpanAtCursor, selectedLanguage])

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
    // Fallback: run the current line (or the block around it)
    void handleRunLine()
  }, [selectedNode, runCode, handleRunLine])

  // Cmd+S: force flush debounced content save
  const handleSaveFile = useCallback(() => {
    if (!selectedNode || isVirtualFile) return
    // saveFile reads the content from the store; without this the last keystrokes
    // of a debounce window would be written to disk as the previous text.
    pendingEditsRef.current?.flush()
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
    // Drop the editor's pending keystrokes BEFORE reverting: its unmount flush
    // would otherwise write them back and re-dirty the file we just discarded.
    pendingEditsRef.current?.discard()
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
      s.shortcuts.run_file_as_job.binding,
    ])
  )

  // Rmd/Qmd and ipynb bind the same notebook actions to different keys, so the
  // menus read the set matching the open file (RunButton does this for scripts).
  // Derived in a memo, not in the selector: a selector returning a fresh object
  // fails Zustand's reference check and re-renders forever.
  const shortcuts = useShortcutStore((s) => s.shortcuts)
  const nbShortcuts = useMemo(() => {
    const p = isIpynbFile ? 'ipynb' : 'rmd'
    const key = (suffix: string) => comboToString(shortcuts[`${p}_${suffix}` as ShortcutActionId].binding)
    return {
      runChunk: key('run_chunk'),
      runChunkStay: key('run_chunk_stay'),
      runAll: key('run_all'),
      runAbove: key('run_above'),
      insertChunk: key('insert_chunk'),
      render: key('render'),
    }
  }, [shortcuts, isIpynbFile])

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
                  <SidebarSearchToggle
                    open={fileSearch.open}
                    onToggle={fileSearch.toggle}
                    label={t('files.search_files')}
                  />
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
              {fileSearch.open && (
                <SidebarSearchField
                  value={fileSearch.query}
                  onChange={fileSearch.setQuery}
                  onClose={fileSearch.toggle}
                  placeholder={t('files.search_files')}
                />
              )}
              {resolvedDirs && <FolderPathBar path={resolvedDirs.ide} />}
              <FileTree onNewChild={openCreate} search={fileSearch.query} />
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
                  <SessionDropdown projectUid={activeProjectUid} language={activeTerminalTab.kind} />
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
                      onRunLine={() => void handleRunLine()}
                      onStop={handleStop}
                      onRunFileAsJob={handleRunFileAsJob}
                      isSql={isSql}
                      isExecuting={isExecuting}
                      language={selectedLanguage as 'python' | 'r' | undefined}
                      projectUid={activeProjectUid ?? undefined}
                    />
                    {/* Session (kernel namespace) selector — server mode, R/Python only.
                        Scoped to the script's language: R scripts list R sessions. */}
                    {(selectedLanguage === 'python' || selectedLanguage === 'r') && activeProjectUid && (
                      <SessionDropdown projectUid={activeProjectUid} language={selectedLanguage} />
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
                      {/* Run cell and advance + dropdown — becomes Stop while a
                          cell or a Run all is in flight, like the script toolbar. */}
                      <div className="flex">
                        {notebookRunning ? (
                          <Button
                            size="xs"
                            variant="destructive"
                            className="gap-1"
                            onClick={() => notebookRef.current?.stopRun()}
                          >
                            <Square size={12} />
                            {t('files.stop')}
                          </Button>
                        ) : (
                          <>
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
                            <DropdownMenuItem onClick={() => notebookRef.current?.runCellAndAdvance()} className="gap-2 text-xs">
                              <StepForward size={13} className="text-muted-foreground" />
                              {t('shortcuts.nb_run_chunk')}
                              {nbShortcuts.runChunk && <DropdownMenuShortcut>{nbShortcuts.runChunk}</DropdownMenuShortcut>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.runCell()} className="gap-2 text-xs">
                              <CornerDownLeft size={13} className="text-muted-foreground" />
                              {t('shortcuts.nb_run_chunk_stay')}
                              {nbShortcuts.runChunkStay && <DropdownMenuShortcut>{nbShortcuts.runChunkStay}</DropdownMenuShortcut>}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => notebookRef.current?.runAll()} className="gap-2 text-xs">
                              <Play size={13} className="text-muted-foreground" />
                              {t('shortcuts.nb_run_all')}
                              {nbShortcuts.runAll && <DropdownMenuShortcut>{nbShortcuts.runAll}</DropdownMenuShortcut>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.runAbove()} className="gap-2 text-xs">
                              <ListEnd size={13} className="text-muted-foreground" />
                              {t('shortcuts.nb_run_above')}
                              {nbShortcuts.runAbove && <DropdownMenuShortcut>{nbShortcuts.runAbove}</DropdownMenuShortcut>}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                          </>
                        )}
                      </div>

                      {/* Same picker as the script toolbar: a notebook's cells
                          reach the database through it too. */}
                      <ConnectionDropdown projectUid={activeProjectUid ?? undefined} />

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
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('code', 'r')} className="gap-2 text-xs">
                              <Code size={13} className="text-muted-foreground" />
                              R
                              {nbShortcuts.insertChunk && <DropdownMenuShortcut>{nbShortcuts.insertChunk}</DropdownMenuShortcut>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('code', 'python')} className="gap-2 text-xs">
                              <Code size={13} className="text-muted-foreground" />
                              Python
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('code', 'sql')} className="gap-2 text-xs">
                              <Database size={13} className="text-muted-foreground" />
                              SQL
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => notebookRef.current?.addCell('markdown')} className="gap-2 text-xs">
                              <FileText size={13} className="text-muted-foreground" />
                              Markdown
                            </DropdownMenuItem>
                            {!notebookRef.current?.hasYamlCell && (
                              <DropdownMenuItem onClick={() => notebookRef.current?.addCell('yaml')} className="gap-2 text-xs">
                                <Settings2 size={13} className="text-muted-foreground" />
                                {t('files.yaml_front_matter')}
                              </DropdownMenuItem>
                            )}
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
                              <DropdownMenuItem onClick={() => (notebookRef.current as IpynbNotebookHandle)?.downloadNotebook(true)} className="gap-2 text-xs">
                                <Download size={13} className="text-muted-foreground" />
                                {t('files.download_with_outputs')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => (notebookRef.current as IpynbNotebookHandle)?.downloadNotebook(false)} className="gap-2 text-xs">
                                <FileCode2 size={13} className="text-muted-foreground" />
                                {t('files.download_without_outputs')}
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
                              <DropdownMenuItem onClick={() => notebookRef.current?.renderPreview()} className="gap-2 text-xs">
                                <Eye size={13} className="text-muted-foreground" />
                                {t('files.render_preview')}
                                {nbShortcuts.render && <DropdownMenuShortcut>{nbShortcuts.render}</DropdownMenuShortcut>}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => notebookRef.current?.renderHtml()} className="gap-2 text-xs">
                                <FileDown size={13} className="text-muted-foreground" />
                                {t('files.render_download_html')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}

                      {/* Raw / Cells toggle — "Raw" is the file's own source
                          (Markdown for an Rmd, JSON for an ipynb). */}
                      <Button
                        variant="outline"
                        size="xs"
                        className="gap-1"
                        onClick={() => notebookRef.current?.toggleSourceView()}
                      >
                        {notebookRef.current?.sourceView
                          ? <><LayoutGrid size={12} /> {t('files.view_cells')}</>
                          : <><FileCode size={12} /> {t('files.view_raw')}</>
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

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setDocsOpen(true)}
                      >
                        <Info size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('docs.title')}</TooltipContent>
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
                    className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
                    style={{ flex: tabSplit.flexFor('left', openFileIds.length > 0 && outputTabOrder.length > 0) }}
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
                    <TabGroupSplitter
                      onShareChange={tabSplit.setShare}
                      onReset={tabSplit.reset}
                    />
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
                    className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
                    style={{ flex: tabSplit.flexFor('right', openFileIds.length > 0 && outputTabOrder.length > 0) }}
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
                                    onOutlineChange={(cells, states) =>
                                      handleOutlineChange(fid, cells, states)
                                    }
                                    onRunningChange={(running) =>
                                      handleNotebookRunningChange(fid, running)
                                    }
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
                                    onOutlineChange={(cells, states) =>
                                      handleOutlineChange(fid, cells, states)
                                    }
                                    onRunningChange={(running) =>
                                      handleNotebookRunningChange(fid, running)
                                    }
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
                            pendingEditsRef={pendingEditsRef}
                            onSave={handleSaveFile}
                            onRunSelectionOrLine={isVirtualFile ? undefined : handleRunSelectionOrLine}
                            onRunFile={isVirtualFile ? undefined : handleRunFile}
                            onRunFileAsJob={isVirtualFile ? undefined : handleRunFileAsJob}
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
                              sessionId={activeSessionId}
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

                      {/* Notebook outline sidebar — same default width as the file explorer */}
                      <Allotment.Pane
                        preferredSize={240}
                        minSize={140}
                        maxSize={400}
                        visible={outlineVisible && isNotebook}
                      >
                        <div className="h-full border-l bg-muted/20 overflow-y-auto">
                          <SectionLabel className="px-2 py-2 border-b">
                            {t('files.outline')}
                          </SectionLabel>
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
        <DocumentationDialog
          open={docsOpen}
          onOpenChange={setDocsOpen}
          language={sessionLanguage}
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
        <DialogShell
          open={!!closeConfirmFileId}
          onOpenChange={(open) => { if (!open) setCloseConfirmFileId(null) }}
          title={t('files.unsaved_changes_title')}
          description={t('files.unsaved_changes_description', {
            name: nodes.find((n) => n.id === closeConfirmFileId)?.name ?? '',
          })}
          onConfirm={handleSaveAndClose}
          confirmLabel={t('common.save')}
          footerExtra={
            <Button variant="destructive" size="sm" onClick={handleDiscardAndClose}>
              {t('files.dont_save')}
            </Button>
          }
        >
          {null}
        </DialogShell>
      </div>
    </TooltipProvider>
  )
}
