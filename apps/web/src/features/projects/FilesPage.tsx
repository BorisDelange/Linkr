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
  Undo2,
  Box,
  Plug,
  X,
  Lock,
  LockOpen,
  Eye,
  EyeOff,
  ChevronLeft,
  ChevronRight,
  Play,
  PlayCircle,
  ChevronDown,
  Plus,
  FileDown,
  FileText,
  Code,
  Loader2,
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
import * as duckdbEngine from '@/lib/duckdb/engine'
import { executePython } from '@/lib/runtimes/pyodide-engine'
import { executeR } from '@/lib/runtimes/webr-engine'
import { FileTree } from './files/FileTree'
import { OutputPanel, getTabIcon } from './files/OutputPanel'
import { CreateFileDialog } from './files/CreateFileDialog'
import { CreateFolderDialog } from './files/CreateFolderDialog'
import { UploadDialog } from './files/UploadDialog'
import { RunButton } from './files/RunButton'
import { TerminalPane } from './files/TerminalPane'
import { KeyboardShortcutsDialog } from './files/KeyboardShortcutsDialog'
import { EditorSettingsDialog } from './files/EditorSettingsDialog'
import { EnvironmentsDialog } from './files/EnvironmentsDialog'
import { ConnectionsPanel } from './files/ConnectionsPanel'
import { useGlobalShortcuts, type ShortcutHandlers } from '@/hooks/use-shortcuts'
import { useShortcutStore } from '@/stores/shortcut-store'

const LazyIpynbViewer = lazy(() => import('./files/IpynbViewer').then(m => ({ default: m.IpynbViewer })))
const LazyRmdNotebook = lazy(() => import('./files/RmdNotebook').then(m => ({ default: m.RmdNotebook })))
import type { RmdNotebookHandle } from './files/RmdNotebook'

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
    loadProjectFiles,
    peekUndo,
    performUndo,
    isFileDirty,
    saveFile,
    revertFile,
    _dirtyVersion,
  } = useFileStore()
  const { bottomPanelOpen, toggleBottomPanel, activeProjectUid } = useAppStore()
  const { activeConnectionId, loadProjectConnections } = useConnectionStore()
  const { isExecuting, startExecution, stopExecution, finishExecution } = useRuntimeStore()
  const loadDataSources = useDataSourceStore((s) => s.loadDataSources)
  const loadCohorts = useCohortStore((s) => s.loadCohorts)
  const loadPipelines = usePipelineStore((s) => s.loadPipelines)
  const { loadProjectDatasets, loadFileData, getFileRows, files: datasetFiles, _dirtyVersion: datasetDirtyVersion } = useDatasetStore()
  const { nodes } = useProjectTree(activeProjectUid)

  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  const [environmentsOpen, setEnvironmentsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [showVirtualFiles, setShowVirtualFiles] = useState(() => localStorage.getItem('linkr-show-virtual-files') === 'true')
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

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const notebookRef = useRef<RmdNotebookHandle>(null)

  const selectedNode = nodes.find((n) => n.id === selectedFileId)
  const isVirtualFile = selectedNode?.virtual === true
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0
  const undoAction = peekUndo()
  const selectedLanguage = selectedNode?.language
  const isSql = selectedLanguage === 'sql' || selectedNode?.name.endsWith('.sql')
  const isIpynbFile = selectedNode?.name.endsWith('.ipynb') ?? false
  const isRmdNotebook = /\.(rmd|qmd)$/i.test(selectedNode?.name ?? '')

  // When a dataset file is selected, redirect it to an output tab instead of a file tab
  useEffect(() => {
    if (!selectedFileId?.startsWith('ds-bridge:')) return
    const node = nodes.find((n) => n.id === selectedFileId)
    if (!node || node.type !== 'file') return

    const dsFileId = selectedFileId.replace('ds-bridge:', '')
    const dsFile = datasetFiles.find((f) => f.id === dsFileId)
    if (!dsFile) return

    // Close the file tab that was auto-opened by selectFile
    closeFile(selectedFileId)

    // Load data then open as output tab
    const outputTabId = `dataset:${dsFileId}`
    loadFileData(dsFileId).then(() => {
      const rows = getFileRows(dsFileId)
      const columns = dsFile.columns ?? []
      const headers = columns.map((c) => c.name)
      const tableRows = rows.map((row) =>
        columns.map((c) => (row[c.id] != null ? String(row[c.id]) : ''))
      )
      addOutputTab({
        id: outputTabId,
        label: dsFile.name,
        type: 'table',
        content: { headers, rows: tableRows },
      })
      setOutputVisible(true)
      setEditorVisible(false)
    })
  }, [selectedFileId, nodes, datasetFiles, closeFile, loadFileData, getFileRows, addOutputTab, setOutputVisible, setEditorVisible])

  // When a CSV/TSV IDE file is selected, open it as a table in the output panel (hide editor)
  useEffect(() => {
    if (!selectedFileId || selectedFileId.startsWith('ds-bridge:') || selectedFileId.startsWith('virtual:')) return
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
  }, [selectedFileId, nodes, addOutputTab, setOutputVisible])

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
      // Clear decorations if switching away from CSV
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
        const result = language === 'python'
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

        // Add figures as output tabs
        for (const fig of result.figures) {
          addOutputTab({
            id: fig.id,
            label: `${fig.label} — ${fileName}`,
            type: 'figure',
            content: fig.data,
          })
          setActiveOutputTab(fig.id)
        }

        // Add table as output tab
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
    [activeConnectionId, t, startExecution, finishExecution, addExecutionResult, updateExecutionResult, addOutputTab, setActiveOutputTab]
  )

  const isMarkdown = selectedLanguage === 'markdown' || selectedNode?.name.endsWith('.md')

  const runCode = useCallback(
    (code: string, label: string) => {
      if (isMarkdown) {
        addOutputTab({
          id: `markdown-${label}`,
          label: `Preview — ${label}`,
          type: 'markdown',
          content: code,
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
    [isMarkdown, isSql, activeConnectionId, executeSql, executeCode, selectedLanguage, addOutputTab, setOutputVisible]
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
  }, [selectedNode, isVirtualFile, saveFile])

  // Close file with unsaved changes confirmation
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

  // Close all file tabs (force close without save prompt)
  const handleCloseAllFiles = useCallback(() => {
    for (const fid of openFileIds) closeFile(fid)
  }, [openFileIds, closeFile])

  // Close all file tabs except the given one
  const handleCloseOtherFiles = useCallback((keepId: string) => {
    for (const fid of openFileIds) {
      if (fid !== keepId) closeFile(fid)
    }
  }, [openFileIds, closeFile])

  // Close all output tabs
  const handleCloseAllOutputTabs = useCallback(() => {
    clearExecutionResults()
    for (const tab of outputTabs) closeOutputTab(tab.id)
  }, [outputTabs, closeOutputTab, clearExecutionResults])

  // Close all output tabs except the given one
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

  // Cmd+K: clear terminal + console output
  const handleClearTerminal = useCallback(() => {
    window.dispatchEvent(new CustomEvent('linkr:clear-terminal'))
    clearExecutionResults()
  }, [clearExecutionResults])

  // Cmd+N: open new file dialog
  const handleNewFile = useCallback(() => {
    setCreateFileOpen(true)
  }, [])

  // Global shortcuts (scope: 'global')
  const globalHandlers: ShortcutHandlers = useMemo(
    () => ({
      toggle_terminal: toggleBottomPanel,
      new_file: handleNewFile,
      clear_terminal: handleClearTerminal,
    }),
    [toggleBottomPanel, handleNewFile, handleClearTerminal]
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
                        onClick={() => setCreateFileOpen(true)}
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
                        onClick={() => setCreateFolderOpen(true)}
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
                        onClick={performUndo}
                        disabled={!undoAction}
                      >
                        <Undo2 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {undoAction
                        ? t('files.undo_action', {
                            action: t(
                              undoAction.descriptionKey,
                              undoAction.descriptionParams
                            ),
                          })
                        : t('files.undo')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={showVirtualFiles ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={() => {
                          const next = !showVirtualFiles
                          setShowVirtualFiles(next)
                          localStorage.setItem('linkr-show-virtual-files', String(next))
                        }}
                      >
                        {showVirtualFiles ? <LockOpen size={14} /> : <Lock size={14} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t(showVirtualFiles ? 'files.hide_protected' : 'files.show_protected')}
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
              <FileTree showVirtualFiles={showVirtualFiles} />
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
                  </>
                )}

                {/* Notebook toolbar buttons (Rmd/Qmd) */}
                {editorVisible && selectedNode && isRmdNotebook && !isVirtualFile && (
                  <>
                    <div className="mx-1 h-4 w-px bg-border" />
                    <div className="flex items-center gap-1.5">
                      {/* Run cell + dropdown */}
                      <div className="flex">
                        <Button
                          size="xs"
                          className="gap-1 rounded-r-none"
                          onClick={() => notebookRef.current?.runCell()}
                        >
                          <Play size={12} />
                          Run cell
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
                            <DropdownMenuItem onClick={() => notebookRef.current?.runCell()}>
                              {t('shortcuts.nb_run_chunk')}
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

                      {/* Render + dropdown */}
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
                            <DropdownMenuItem onClick={() => notebookRef.current?.renderPdf()}>
                              Print / PDF
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

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
                    </div>
                  </>
                )}

                <div className="ml-auto flex items-center gap-1">
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

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setEnvironmentsOpen(true)}
                      >
                        <Box size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('environments.title')}</TooltipContent>
                  </Tooltip>

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
                        variant={bottomPanelOpen ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={toggleBottomPanel}
                      >
                        <Terminal size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.terminal')}</TooltipContent>
                  </Tooltip>

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
              {(openFileIds.length > 0 || outputTabOrder.length > 0) && (
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
                      {/* Editor panel */}
                      <Allotment.Pane minSize={150} visible={editorVisible}>
                        {selectedNode && isIpynbFile ? (
                          <Suspense fallback={
                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                              Loading notebook...
                            </div>
                          }>
                            <LazyIpynbViewer
                              key={selectedFileId}
                              content={selectedNode.content ?? ''}
                            />
                          </Suspense>
                        ) : selectedNode && isRmdNotebook ? (
                          <Suspense fallback={
                            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                              Loading notebook...
                            </div>
                          }>
                            <LazyRmdNotebook
                              ref={notebookRef}
                              key={selectedFileId}
                              content={selectedNode.content ?? ''}
                              onChange={isVirtualFile ? undefined : (v) =>
                                updateFileContent(selectedNode.id, v)
                              }
                              readOnly={isVirtualFile}
                              onSave={handleSaveFile}
                              onRenderOutput={(html, title) => {
                                addOutputTab({
                                  id: `render-${selectedFileId}`,
                                  label: `Render — ${title}`,
                                  type: 'html',
                                  content: html,
                                })
                                setOutputVisible(true)
                              }}
                              activeConnectionId={activeConnectionId}
                            />
                          </Suspense>
                        ) : selectedNode ? (
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
                        ) : (
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

                  {/* Bottom: terminal panel */}
                  {bottomPanelOpen && (
                    <Allotment.Pane
                      preferredSize={250}
                      minSize={120}
                      maxSize={500}
                    >
                      <TerminalPane
                        onClose={toggleBottomPanel}
                      />
                    </Allotment.Pane>
                  )}
                </Allotment>
              </div>
            </div>
          </Allotment.Pane>
        </Allotment>

        <CreateFileDialog
          open={createFileOpen}
          onOpenChange={setCreateFileOpen}
          parentId={null}
        />
        <CreateFolderDialog
          open={createFolderOpen}
          onOpenChange={setCreateFolderOpen}
          parentId={null}
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
        <EditorSettingsDialog
          open={editorSettingsOpen}
          onOpenChange={setEditorSettingsOpen}
        />
        <EnvironmentsDialog
          open={environmentsOpen}
          onOpenChange={setEnvironmentsOpen}
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
