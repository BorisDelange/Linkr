import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  FileCode,
  FilePlus,
  PanelLeft,
  Eye,
  EyeOff,
  Play,
  PlayCircle,
  Square,
  ChevronLeft,
  ChevronRight,
  X,
  Table2,
  Keyboard,
  ArrowLeft,
  Database,
  Copy,
  Check,
  Code,
  FileText,
  TableIcon,
  FolderPlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { useSqlScriptsStore, type SqlOutputTab, type SqlExecutionResult } from '@/stores/sql-scripts-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { SqlScriptsFileTree } from './SqlScriptsFileTree'
import * as duckdbEngine from '@/lib/duckdb/engine'
import type { SqlScriptFile } from '@/types'

interface Props {
  collectionId: string
}

export function SqlScriptsEditorPage({ collectionId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    collections,
    collectionsLoaded,
    loadCollections,
    files,
    filesLoaded,
    loadCollectionFiles,
    selectedFileId,
    openFileIds,
    selectFile,
    closeFile,
    updateFileContent,
    createFile,
    isFileDirty,
    saveFile,
    revertFile,
    outputTabs,
    outputTabOrder,
    activeOutputTab,
    executionResults,
    addExecutionResult,
    addOutputTab,
    setActiveOutputTab,
    closeOutputTab,
    clearExecutionResults,
    outputVisible,
    setOutputVisible,
    _dirtyVersion,
    updateFile,
  } = useSqlScriptsStore()

  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFolderMode, setCreateFolderMode] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [copiedRef, setCopiedRef] = useState<string | null>(null)

  const fileTabScrollRef = useRef<HTMLDivElement>(null)
  const outputTabScrollRef = useRef<HTMLDivElement>(null)

  const scrollTabs = useCallback((ref: React.RefObject<HTMLDivElement | null>, dir: 'left' | 'right') => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  // Load collections + files
  useEffect(() => {
    if (!collectionsLoaded) loadCollections()
  }, [collectionsLoaded, loadCollections])

  useEffect(() => {
    loadCollectionFiles(collectionId)
  }, [collectionId, loadCollectionFiles])

  const collection = collections.find((c) => c.id === collectionId)
  const selectedFile = files.find((f) => f.id === selectedFileId)
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0

  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  // Resolve which data source a file should run against
  const resolveFileDataSourceId = useCallback(
    (file: SqlScriptFile | undefined): string | undefined => {
      if (file?.dataSourceId) return file.dataSourceId
      return collection?.defaultDataSourceId
    },
    [collection?.defaultDataSourceId],
  )

  const selectedFileDataSourceId = resolveFileDataSourceId(selectedFile)
  const selectedFileDs = dataSources.find((ds) => ds.id === selectedFileDataSourceId)

  // Ensure default database is mounted on load
  useEffect(() => {
    if (!collection?.defaultDataSourceId) return
    const { testConnection } = useDataSourceStore.getState()
    testConnection(collection.defaultDataSourceId)
  }, [collection?.defaultDataSourceId])

  // Create new file
  const handleCreateFile = async () => {
    let name = newFileName.trim()
    if (!name) return

    if (createFolderMode) {
      const now = new Date().toISOString()
      const folder: SqlScriptFile = {
        id: crypto.randomUUID(),
        collectionId,
        name,
        type: 'folder',
        parentId: null,
        order: files.length,
        createdAt: now,
      }
      await createFile(folder)
    } else {
      if (!name.includes('.')) name = `${name}.sql`
      const now = new Date().toISOString()
      const file: SqlScriptFile = {
        id: crypto.randomUUID(),
        collectionId,
        name,
        type: 'file',
        parentId: null,
        content: '',
        order: files.length,
        createdAt: now,
      }
      await createFile(file)
      selectFile(file.id)
    }
    setCreateFileOpen(false)
    setNewFileName('')
    setCreateFolderMode(false)
  }

  // Execute SQL
  const executeSql = useCallback(
    async (sql: string, label: string, dataSourceId?: string) => {
      const dsId = dataSourceId ?? collection?.defaultDataSourceId
      if (!dsId) return
      const { testConnection } = useDataSourceStore.getState()
      await testConnection(dsId)
      const start = Date.now()
      try {
        const rows = await duckdbEngine.queryDataSource(dsId, sql)
        const duration = Date.now() - start
        addExecutionResult({
          id: `exec-${Date.now()}`,
          fileName: label,
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
        addExecutionResult({
          id: `exec-${Date.now()}`,
          fileName: label,
          timestamp: start,
          duration,
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: sql,
        })
      }
    },
    [collection?.defaultDataSourceId, addExecutionResult, addOutputTab],
  )

  const handleRunFile = useCallback(async () => {
    if (!selectedFile?.content) return
    setIsRunning(true)
    try {
      await executeSql(selectedFile.content, selectedFile.name, resolveFileDataSourceId(selectedFile))
    } finally {
      setIsRunning(false)
    }
  }, [selectedFile, executeSql, resolveFileDataSourceId])

  const handleRunAll = useCallback(async () => {
    const sqlFiles = files
      .filter((f) => f.type === 'file')
      .sort((a, b) => a.order - b.order)
    if (sqlFiles.length === 0) return
    setIsRunning(true)
    try {
      for (const file of sqlFiles) {
        if (!file.content) continue
        await executeSql(file.content, file.name, resolveFileDataSourceId(file))
      }
    } finally {
      setIsRunning(false)
    }
  }, [files, executeSql, resolveFileDataSourceId])

  const handleSaveFile = useCallback(() => {
    if (selectedFileId) saveFile(selectedFileId)
  }, [selectedFileId, saveFile])

  const handleCloseFile = useCallback(
    (fid: string) => {
      if (isFileDirty(fid)) {
        setCloseConfirmFileId(fid)
      } else {
        closeFile(fid)
      }
    },
    [isFileDirty, closeFile],
  )

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

  // Keyboard shortcut: Cmd+Shift+Enter = Run All
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        handleRunAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleRunAll])

  if (!collection) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('sql_scripts.collection_not_found')}</p>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => navigate('..')}>
                <ArrowLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('sql_scripts.back_to_list')}</TooltipContent>
          </Tooltip>
          <span className="text-sm font-medium">{collection.name}</span>
        </div>

        {/* IDE */}
        <div className="flex-1 overflow-hidden">
          <Allotment>
            {/* Explorer sidebar */}
            <Allotment.Pane preferredSize={240} minSize={140} maxSize={400} visible={explorerVisible}>
              <div className="flex h-full flex-col border-r">
                <div className="flex items-center justify-between border-b px-2 py-1.5">
                  <div className="flex items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" onClick={() => { setCreateFolderMode(false); setCreateFileOpen(true) }}>
                          <FilePlus size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('sql_scripts.new_file')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" onClick={() => { setCreateFolderMode(true); setCreateFileOpen(true) }}>
                          <FolderPlus size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.new_folder')}</TooltipContent>
                    </Tooltip>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs" onClick={() => setExplorerVisible(false)}>
                        <PanelLeft size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('files.collapse_explorer')}</TooltipContent>
                  </Tooltip>
                </div>
                <SqlScriptsFileTree />
              </div>
            </Allotment.Pane>

            {/* Editor area */}
            <Allotment.Pane minSize={150}>
              <div className="flex h-full flex-col">
                {/* Toolbar */}
                <div className="flex items-center gap-1 border-b px-3 py-1.5">
                  {!explorerVisible && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" onClick={() => setExplorerVisible(true)}>
                          <PanelLeft size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('files.expand_explorer')}</TooltipContent>
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

                  {editorVisible && selectedFile && (
                    <>
                      <div className="mx-1 h-4 w-px bg-border" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={isRunning ? undefined : handleRunFile}
                            disabled={isRunning}
                          >
                            <Play size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('sql_scripts.run_file')} (⇧↵)</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={isRunning ? undefined : handleRunAll}
                            disabled={isRunning}
                          >
                            <PlayCircle size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('sql_scripts.run_all')} (⌘⇧↵)</TooltipContent>
                      </Tooltip>
                      {isRunning && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon-xs" onClick={() => setIsRunning(false)}>
                              <Square size={14} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('sql_scripts.stop')}</TooltipContent>
                        </Tooltip>
                      )}

                      {/* Per-file database selector */}
                      <div className="mx-1 h-4 w-px bg-border" />
                      <Select
                        value={selectedFile.dataSourceId ?? '__default__'}
                        onValueChange={(value) => {
                          updateFile(selectedFile.id, { dataSourceId: value === '__default__' ? undefined : value })
                        }}
                      >
                        <SelectTrigger className="h-6 w-auto gap-1.5 border-0 bg-transparent px-1.5 text-[11px] shadow-none hover:bg-accent/50">
                          <Database size={11} className={selectedFile.dataSourceId ? 'text-amber-500' : 'text-muted-foreground'} />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">
                            <span className="flex items-center gap-1.5">
                              {collection.defaultDataSourceId
                                ? dataSources.find((ds) => ds.id === collection.defaultDataSourceId)?.name ?? t('sql_scripts.select_database')
                                : t('sql_scripts.select_database')}
                              {collection.defaultDataSourceId && (
                                <span className="text-[10px] text-muted-foreground">({t('sql_scripts.script_db_default')})</span>
                              )}
                            </span>
                          </SelectItem>
                          {dbSources
                            .filter((ds) => ds.id !== collection.defaultDataSourceId)
                            .map((ds) => (
                            <SelectItem key={ds.id} value={ds.id}>
                              {ds.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Copy schema reference */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              const dsId = resolveFileDataSourceId(selectedFile)
                              if (!dsId) return
                              const ds = dataSources.find((d) => d.id === dsId)
                              const ref = `"ds_${ds?.alias ?? dsId.replace(/[^a-zA-Z0-9]/g, '_')}"`
                              navigator.clipboard.writeText(ref)
                              setCopiedRef(ref)
                              setTimeout(() => setCopiedRef(null), 2000)
                            }}
                          >
                            {copiedRef ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {copiedRef ? `${t('sql_scripts.copied')}: ${copiedRef}` : t('sql_scripts.copy_schema_ref')}
                        </TooltipContent>
                      </Tooltip>
                    </>
                  )}

                  <div className="ml-auto flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setSchemaDialogOpen(true)}
                          disabled={!selectedFileDataSourceId}
                        >
                          <Table2 size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('sql_scripts.browse_schema')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" onClick={() => setShortcutsOpen(true)}>
                          <Keyboard size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('files.shortcuts')}</TooltipContent>
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

                {/* Unified tab bar */}
                {(openFileIds.length > 0 || outputTabOrder.length > 0) && (
                  <div className="flex items-center border-b bg-muted/30">
                    {openFileIds.length > 0 && (
                      <button
                        onClick={() => scrollTabs(fileTabScrollRef, 'left')}
                        className="shrink-0 px-0.5 py-1.5 text-muted-foreground/25 hover:text-muted-foreground"
                      >
                        <ChevronLeft size={12} />
                      </button>
                    )}
                    <div ref={fileTabScrollRef} className="flex items-center overflow-x-auto scrollbar-none">
                      {openFileIds.map((fid) => {
                        const file = files.find((f) => f.id === fid)
                        if (!file) return null
                        const isActive = fid === selectedFileId
                        const isDirty = _dirtyVersion >= 0 && isFileDirty(fid)
                        return (
                          <ContextMenu key={fid}>
                            <ContextMenuTrigger asChild>
                              <button
                                onClick={() => {
                                  selectFile(fid)
                                  if (!editorVisible) setEditorVisible(true)
                                }}
                                className={cn(
                                  'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                  isActive
                                    ? 'bg-background text-foreground'
                                    : 'text-muted-foreground hover:bg-accent/50',
                                )}
                              >
                                <span className="max-w-[140px] truncate" title={file.name}>{file.name}</span>
                                {isDirty && <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-orange-400" />}
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
                              <ContextMenuItem onClick={() => handleCloseFile(fid)}>{t('files.close')}</ContextMenuItem>
                              <ContextMenuItem onClick={() => {
                                for (const id of openFileIds) { if (id !== fid) closeFile(id) }
                              }}>{t('files.close_others')}</ContextMenuItem>
                              <ContextMenuItem onClick={() => {
                                for (const id of openFileIds) closeFile(id)
                              }}>{t('files.close_all')}</ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        )
                      })}
                    </div>
                    {openFileIds.length > 0 && (
                      <button
                        onClick={() => scrollTabs(fileTabScrollRef, 'right')}
                        className="shrink-0 px-0.5 py-1.5 text-muted-foreground/25 hover:text-muted-foreground"
                      >
                        <ChevronRight size={12} />
                      </button>
                    )}

                    {openFileIds.length > 0 && outputTabOrder.length > 0 && (
                      <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                    )}

                    {outputTabOrder.length > 0 && (
                      <button
                        onClick={() => scrollTabs(outputTabScrollRef, 'left')}
                        className="shrink-0 px-0.5 py-1.5 text-muted-foreground/25 hover:text-muted-foreground"
                      >
                        <ChevronLeft size={12} />
                      </button>
                    )}
                    <div ref={outputTabScrollRef} className="flex items-center overflow-x-auto scrollbar-none">
                      {outputTabOrder.map((tabId) => {
                        const isConsole = tabId === '__exec_console__'
                        const isActive = activeOutputTab === tabId

                        if (isConsole) {
                          return (
                            <ContextMenu key={tabId}>
                              <ContextMenuTrigger asChild>
                                <button
                                  onClick={() => {
                                    setActiveOutputTab(tabId)
                                    if (!outputVisible) setOutputVisible(true)
                                  }}
                                  className={cn(
                                    'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                    isActive && outputVisible
                                      ? 'bg-primary/10 text-foreground'
                                      : 'bg-primary/5 text-muted-foreground hover:bg-primary/10',
                                  )}
                                >
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
                                <ContextMenuItem onClick={() => clearExecutionResults()}>{t('files.close')}</ContextMenuItem>
                                <ContextMenuItem onClick={() => {
                                  for (const id of outputTabOrder) {
                                    if (id === '__exec_console__') clearExecutionResults()
                                    else closeOutputTab(id)
                                  }
                                }}>{t('files.close_all')}</ContextMenuItem>
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
                                onClick={() => {
                                  setActiveOutputTab(tab.id)
                                  if (!outputVisible) setOutputVisible(true)
                                }}
                                className={cn(
                                  'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                  tab.id === activeOutputTab && outputVisible
                                    ? 'bg-primary/10 text-foreground'
                                    : 'bg-primary/5 text-muted-foreground hover:bg-primary/10',
                                )}
                              >
                                {tab.type === 'table' ? <TableIcon size={12} /> : <FileText size={12} />}
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
                              <ContextMenuItem onClick={() => closeOutputTab(tab.id)}>{t('files.close')}</ContextMenuItem>
                              <ContextMenuItem onClick={() => {
                                for (const id of outputTabOrder) {
                                  if (id === '__exec_console__') clearExecutionResults()
                                  else closeOutputTab(id)
                                }
                              }}>{t('files.close_all')}</ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        )
                      })}
                    </div>
                    {outputTabOrder.length > 0 && (
                      <button
                        onClick={() => scrollTabs(outputTabScrollRef, 'right')}
                        className="shrink-0 px-0.5 py-1.5 text-muted-foreground/25 hover:text-muted-foreground"
                      >
                        <ChevronRight size={12} />
                      </button>
                    )}
                  </div>
                )}

                {/* Editor + Output */}
                <div className="flex-1 overflow-hidden">
                  <Allotment key={`eo-${editorVisible}-${outputVisible && hasOutput}`}>
                    {editorVisible && (
                      <Allotment.Pane minSize={150}>
                        {selectedFile ? (
                          <CodeEditor
                            key={selectedFileId}
                            value={selectedFile.content ?? ''}
                            language="sql"
                            onChange={(v) => updateFileContent(selectedFile.id, v ?? '')}
                            onSave={handleSaveFile}
                            onRunFile={handleRunFile}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                              <FileCode size={32} className="mx-auto text-muted-foreground/50" />
                              <p className="mt-3 text-sm text-muted-foreground">{t('files.select_file')}</p>
                            </div>
                          </div>
                        )}
                      </Allotment.Pane>
                    )}

                    {outputVisible && hasOutput && (
                      <Allotment.Pane minSize={200}>
                        <div className="flex h-full flex-col border-l">
                          <SqlOutputContent
                            activeOutputTab={activeOutputTab}
                            outputTabs={outputTabs}
                            executionResults={executionResults}
                          />
                        </div>
                      </Allotment.Pane>
                    )}
                  </Allotment>
                </div>
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>

      {/* Create file/folder dialog */}
      <Dialog open={createFileOpen} onOpenChange={setCreateFileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{createFolderMode ? t('common.new_folder') : t('sql_scripts.new_file')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{createFolderMode ? t('common.name') : t('sql_scripts.file_name')}</Label>
              <Input
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder={createFolderMode ? 'measurement' : 'urine_output.sql'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFile()
                }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFileOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateFile} disabled={!newFileName.trim()}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved changes dialog */}
      <Dialog open={!!closeConfirmFileId} onOpenChange={(open) => { if (!open) setCloseConfirmFileId(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.unsaved_changes_title')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('files.unsaved_changes_description', {
              name: files.find((f) => f.id === closeConfirmFileId)?.name ?? '',
            })}
          </p>
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={() => setCloseConfirmFileId(null)}>
              {t('common.cancel')}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleDiscardAndClose}>{t('files.dont_save')}</Button>
              <Button onClick={handleSaveAndClose}>{t('common.save')}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Database schema browser */}
      {selectedFileDataSourceId && (
        <SchemaInspectorDialog
          open={schemaDialogOpen}
          onOpenChange={setSchemaDialogOpen}
          dataSourceId={selectedFileDataSourceId}
        />
      )}

      {/* Keyboard shortcuts dialog */}
      <SqlShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// SchemaInspectorDialog
// ---------------------------------------------------------------------------

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
}

function SchemaInspectorDialog({
  open,
  onOpenChange,
  dataSourceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dataSourceId: string
}) {
  const { t } = useTranslation()
  const [tables, setTables] = useState<string[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    duckdbEngine.discoverTables(dataSourceId).then((result) => {
      if (cancelled) return
      setTables(result)
      setSelectedTable(result[0] ?? null)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, dataSourceId])

  useEffect(() => {
    if (!selectedTable || !open) {
      setColumns([])
      return
    }
    setCopied(false)
    let cancelled = false
    duckdbEngine
      .queryDataSource(
        dataSourceId,
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${selectedTable}' ORDER BY ordinal_position`,
      )
      .then((rows) => {
        if (cancelled) return
        setColumns(
          rows.map((r) => ({
            column_name: String(r.column_name),
            data_type: String(r.data_type),
            is_nullable: String(r.is_nullable),
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setColumns([])
      })
    return () => { cancelled = true }
  }, [selectedTable, open, dataSourceId])

  const handleCopySelect = useCallback(() => {
    if (!selectedTable || columns.length === 0) return
    const cols = columns.map((c) => `  ${c.column_name}`).join(',\n')
    const sql = `SELECT\n${cols}\nFROM ${selectedTable}\nLIMIT 100;`
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [selectedTable, columns])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('sql_scripts.browse_schema')}</DialogTitle>
        </DialogHeader>
        <div className="flex h-[560px] gap-0 overflow-hidden rounded-md border">
          <div className="w-48 shrink-0 overflow-y-auto border-r bg-muted/30">
            {loading && (
              <p className="p-3 text-xs text-muted-foreground">{t('common.loading')}…</p>
            )}
            {!loading && tables.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">{t('sql_scripts.no_tables')}</p>
            )}
            {tables.map((table) => (
              <button
                key={table}
                onClick={() => setSelectedTable(table)}
                className={cn(
                  'flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors',
                  selectedTable === table
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Table2 size={12} className="shrink-0 text-blue-500" />
                <span className="truncate">{table}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedTable && columns.length > 0 && (
              <>
                <div className="flex items-center justify-between border-b px-3 py-1.5">
                  <span className="text-xs font-medium">{selectedTable}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleCopySelect}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                        {t('sql_scripts.copy_select')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('sql_scripts.copy_select_tooltip')}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/50">
                      <tr className="border-b">
                        <th className="px-3 py-2 text-left font-medium">{t('sql_scripts.column_name')}</th>
                        <th className="px-3 py-2 text-left font-medium">{t('sql_scripts.data_type')}</th>
                        <th className="px-3 py-2 text-left font-medium">{t('sql_scripts.nullable')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((col) => (
                        <tr key={col.column_name} className="border-b last:border-0 hover:bg-accent/30">
                          <td className="px-3 py-1.5 font-mono">{col.column_name}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{col.data_type}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{col.is_nullable === 'YES' ? '✓' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {selectedTable && columns.length === 0 && !loading && (
              <p className="p-4 text-xs text-muted-foreground">{t('sql_scripts.no_columns')}</p>
            )}
            {!selectedTable && (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t('sql_scripts.select_table')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// SqlOutputContent
// ---------------------------------------------------------------------------

function SqlOutputContent({
  activeOutputTab,
  outputTabs,
  executionResults,
}: {
  activeOutputTab: string | null
  outputTabs: SqlOutputTab[]
  executionResults: SqlExecutionResult[]
}) {
  const { t } = useTranslation()
  const isConsoleTab = activeOutputTab === '__exec_console__'
  const activeTab = outputTabs.find((tab) => tab.id === activeOutputTab)

  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isConsoleTab || executionResults.length === 0) return
    const timer = setTimeout(() => {
      if (scrollSentinelRef.current) {
        scrollSentinelRef.current.scrollIntoView({ behavior: 'smooth' })
      } else if (scrollAreaRef.current) {
        const viewport = scrollAreaRef.current.querySelector('[data-slot="scroll-area-viewport"]')
        if (viewport) viewport.scrollTop = viewport.scrollHeight
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [isConsoleTab, executionResults.length])

  if (!activeOutputTab) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <FileText size={24} className="mx-auto text-muted-foreground/50" />
          <p className="mt-2 text-xs text-muted-foreground">{t('files.no_output')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      {isConsoleTab && (
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="space-y-1 p-2">
            {executionResults.map((result) => (
              <SqlResultCard key={result.id} result={result} />
            ))}
            <div ref={scrollSentinelRef} />
          </div>
        </ScrollArea>
      )}
      {!isConsoleTab && activeTab?.type === 'table' && (
        <OutputTable
          headers={(activeTab.content as { headers: string[] })?.headers ?? []}
          rows={(activeTab.content as { rows: string[][] })?.rows ?? []}
        />
      )}
      {!isConsoleTab && activeTab?.type === 'text' && (
        <ScrollArea className="h-full">
          <pre className="whitespace-pre-wrap p-4 font-mono text-xs">{String(activeTab.content)}</pre>
        </ScrollArea>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SqlResultCard
// ---------------------------------------------------------------------------

function SqlResultCard({ result }: { result: SqlExecutionResult }) {
  const { t } = useTranslation()
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)

  const displayText = showCode ? (result.code ?? '') : result.output
  const hasCode = !!result.code

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(displayText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [displayText])

  return (
    <div
      className={cn(
        'rounded-md border p-3',
        result.success ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5',
      )}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium">{result.fileName}</span>
        <div className="flex items-center gap-1">
          {hasCode && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowCode((v) => !v)}
                  className={cn(
                    'rounded p-1 transition-colors',
                    showCode
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <Code size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{showCode ? t('files.show_output') : t('files.show_code')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('files.copy')}</TooltipContent>
          </Tooltip>
          <span className="ml-1 text-[10px] text-muted-foreground">
            {new Date(result.timestamp).toLocaleTimeString()}
          </span>
          {result.duration > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {result.duration >= 1000 ? `${(result.duration / 1000).toFixed(1)}s` : `${result.duration}ms`}
            </span>
          )}
        </div>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{displayText}</pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SqlShortcutsDialog
// ---------------------------------------------------------------------------

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

const SQL_SHORTCUTS = [
  { labelKey: 'sql_scripts.shortcut_save', keys: isMac ? ['⌘', 'S'] : ['Ctrl', 'S'] },
  { labelKey: 'sql_scripts.shortcut_run_file', keys: ['⇧', '↵'] },
  { labelKey: 'sql_scripts.shortcut_run_all', keys: isMac ? ['⌘', '⇧', '↵'] : ['Ctrl', '⇧', '↵'] },
  { labelKey: 'sql_scripts.shortcut_find', keys: isMac ? ['⌘', 'F'] : ['Ctrl', 'F'] },
  { labelKey: 'sql_scripts.shortcut_replace', keys: isMac ? ['⌘', 'H'] : ['Ctrl', 'H'] },
  { labelKey: 'sql_scripts.shortcut_comment', keys: isMac ? ['⌘', '/'] : ['Ctrl', '/'] },
]

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}

function SqlShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('files.shortcuts')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          {SQL_SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.labelKey}
              className="flex items-center justify-between rounded-md px-2 py-1.5"
            >
              <span className="text-sm">{t(shortcut.labelKey)}</span>
              <div className="flex items-center gap-0.5">
                {shortcut.keys.map((key, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    {i > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
                    <Kbd>{key}</Kbd>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
