import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
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
  PanelRight,
  Terminal,
  Settings2,
  Keyboard,
  Undo2,
  Box,
  Plug,
  X,
  Lock,
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
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { useFileStore, type ExecLanguage } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useConnectionStore } from '@/stores/connection-store'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useProjectTree } from '@/hooks/use-project-tree'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { executePython } from '@/lib/runtimes/pyodide-engine'
import { executeR } from '@/lib/runtimes/webr-engine'
import { FileTree } from './files/FileTree'
import { OutputPanel, getExecLang, EXEC_TAB_LABELS, getTabIcon } from './files/OutputPanel'
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
    clearExecutionResultsByLanguage,
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
  const { nodes } = useProjectTree(activeProjectUid)

  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  const [environmentsOpen, setEnvironmentsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [dragFileId, setDragFileId] = useState<string | null>(null)
  const [dropFileInsert, setDropFileInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [dragOutputTabId, setDragOutputTabId] = useState<string | null>(null)
  const [dropOutputInsert, setDropOutputInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)

  // Load connections, files, and other stores when the project changes
  useEffect(() => {
    if (activeProjectUid) {
      loadProjectConnections(activeProjectUid)
      loadProjectFiles(activeProjectUid)
      loadDataSources()
      loadCohorts()
      loadPipelines()
    }
  }, [activeProjectUid, loadProjectConnections, loadProjectFiles, loadDataSources, loadCohorts, loadPipelines])

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  const selectedNode = nodes.find((n) => n.id === selectedFileId)
  const isVirtualFile = selectedNode?.virtual === true
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0
  const undoAction = peekUndo()
  const selectedLanguage = selectedNode?.language
  const isSql = selectedLanguage === 'sql' || selectedNode?.name.endsWith('.sql')

  // Group execution results by language (for output tab badges)
  const resultsByLang = useMemo(() => {
    const map = new Map<ExecLanguage, number>()
    for (const r of executionResults) {
      map.set(r.language, (map.get(r.language) ?? 0) + 1)
    }
    return map
  }, [executionResults])

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

  const runCode = useCallback(
    (code: string, label: string) => {
      if (isSql && activeConnectionId) {
        executeSql(code, label)
      } else if (selectedLanguage === 'python') {
        executeCode(code, label, 'python')
      } else if (selectedLanguage === 'r') {
        executeCode(code, label, 'r')
      }
    },
    [isSql, activeConnectionId, executeSql, executeCode, selectedLanguage]
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

  // Cmd+K: clear terminal via custom event
  const handleClearTerminal = useCallback(() => {
    window.dispatchEvent(new CustomEvent('linkr:clear-terminal'))
  }, [])

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
              <FileTree />
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
                      <PanelLeft size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('files.toggle_editor')}</TooltipContent>
                </Tooltip>

                {selectedNode && !isVirtualFile && (
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

                <div className="ml-auto flex items-center gap-1">
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
                        <PanelRight size={14} />
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
                  <div className="flex items-center overflow-x-auto">
                    {openFileIds.map((fid) => {
                      const node = nodes.find((n) => n.id === fid)
                      if (!node) return null
                      const isActive = fid === selectedFileId
                      const isVirtual = node.virtual === true
                      const isDirty = !isVirtual && _dirtyVersion >= 0 && isFileDirty(fid)
                      return (
                        <button
                          key={fid}
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
                            if (side === 'right') toIdx = Math.min(toIdx + 1, openFileIds.length - 1)
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
                      )
                    })}
                  </div>

                  {/* Vertical separator between file tabs and output tabs */}
                  {openFileIds.length > 0 && outputTabOrder.length > 0 && (
                    <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                  )}

                  {/* Output tabs */}
                  <div className="flex items-center overflow-x-auto">
                    {outputTabOrder.map((tabId) => {
                      const execLang = getExecLang(tabId)
                      const isActive = activeOutputTab === tabId

                      if (execLang) {
                        const count = resultsByLang.get(execLang) ?? 0
                        return (
                          <button
                            key={tabId}
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
                              if (side === 'right') toIdx = Math.min(toIdx + 1, outputTabOrder.length - 1)
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
                            <span>{EXEC_TAB_LABELS[execLang]}</span>
                            <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                              {count}
                            </span>
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                clearExecutionResultsByLanguage(execLang)
                              }}
                              className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                            >
                              <X size={10} />
                            </span>
                          </button>
                        )
                      }

                      const tab = outputTabs.find((t) => t.id === tabId)
                      if (!tab) return null

                      return (
                        <button
                          key={tab.id}
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
                            if (side === 'right') toIdx = Math.min(toIdx + 1, outputTabOrder.length - 1)
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
                      )
                    })}
                  </div>
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
                        {selectedNode ? (
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
