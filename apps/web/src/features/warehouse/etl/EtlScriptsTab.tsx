import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { TableIcon, FileText, Copy, Code, Check } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useEtlStore, type EtlOutputTab, type EtlExecutionResult } from '@/stores/etl-store'
import { EtlFileTree } from './EtlFileTree'
import * as duckdbEngine from '@/lib/duckdb/engine'
import type { EtlFile } from '@/types'

function getTabIcon(type: string) {
  switch (type) {
    case 'table':
      return <TableIcon size={12} />
    default:
      return <FileText size={12} />
  }
}

interface Props {
  pipelineId: string
}

export function EtlScriptsTab({ pipelineId }: Props) {
  const { t } = useTranslation()
  const {
    files,
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
    etlPipelines,
  } = useEtlStore()

  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)

  // Tab scroll refs
  const fileTabScrollRef = useRef<HTMLDivElement>(null)
  const outputTabScrollRef = useRef<HTMLDivElement>(null)

  const scrollTabs = useCallback((ref: React.RefObject<HTMLDivElement | null>, dir: 'left' | 'right') => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  const selectedFile = files.find((f) => f.id === selectedFileId)
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)

  // Infer language from file name
  const inferLanguage = (name: string): 'sql' | 'python' | 'r' | undefined => {
    const ext = name.split('.').pop()?.toLowerCase()
    if (ext === 'sql') return 'sql'
    if (ext === 'py') return 'python'
    if (ext === 'r' || ext === 'rmd') return 'r'
    return undefined
  }

  const editorLanguage = useMemo(() => {
    if (!selectedFile) return 'plaintext'
    if (selectedFile.language) return selectedFile.language
    return inferLanguage(selectedFile.name) ?? 'plaintext'
  }, [selectedFile])

  // Create new file
  const handleCreateFile = async () => {
    const name = newFileName.trim()
    if (!name) return
    const lang = inferLanguage(name)
    const now = new Date().toISOString()
    const file: EtlFile = {
      id: crypto.randomUUID(),
      pipelineId,
      name,
      type: 'file',
      parentId: null,
      content: '',
      language: lang,
      order: files.length,
      createdAt: now,
    }
    await createFile(file)
    selectFile(file.id)
    setCreateFileOpen(false)
    setNewFileName('')
  }

  // Execute SQL against source data source
  const executeSql = useCallback(
    async (sql: string, label: string) => {
      if (!pipeline?.sourceDataSourceId) return
      const start = Date.now()
      try {
        const rows = await duckdbEngine.queryDataSource(pipeline.sourceDataSourceId, sql)
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
        addExecutionResult({
          id: `exec-${Date.now()}`,
          fileName: label,
          language: 'sql',
          timestamp: start,
          duration,
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: sql,
        })
      }
    },
    [pipeline?.sourceDataSourceId, addExecutionResult, addOutputTab],
  )

  // Run current file
  const handleRunFile = useCallback(async () => {
    if (!selectedFile?.content) return
    setIsRunning(true)
    try {
      await executeSql(selectedFile.content, selectedFile.name)
    } finally {
      setIsRunning(false)
    }
  }, [selectedFile, executeSql])

  // Run all files sequentially
  const handleRunAll = useCallback(async () => {
    const sqlFiles = files
      .filter((f) => f.type === 'file' && (f.language === 'sql' || f.name.endsWith('.sql')))
      .sort((a, b) => a.order - b.order)
    if (sqlFiles.length === 0) return
    setIsRunning(true)
    try {
      for (const file of sqlFiles) {
        if (!file.content) continue
        await executeSql(file.content, file.name)
      }
    } finally {
      setIsRunning(false)
    }
  }, [files, executeSql])

  // Save file
  const handleSaveFile = useCallback(() => {
    if (selectedFileId) saveFile(selectedFileId)
  }, [selectedFileId, saveFile])

  // Close file with dirty check
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

  // Keyboard shortcut: Cmd+S
  const handleEditorSave = useCallback(() => {
    handleSaveFile()
  }, [handleSaveFile])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full overflow-hidden">
        <Allotment>
          {/* Explorer sidebar */}
          <Allotment.Pane preferredSize={240} minSize={140} maxSize={400} visible={explorerVisible}>
            <div className="flex h-full flex-col border-r">
              {/* Sidebar header */}
              <div className="flex items-center justify-between border-b px-2 py-1.5">
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs" onClick={() => setCreateFileOpen(true)}>
                        <FilePlus size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('etl.new_file')}</TooltipContent>
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
              <EtlFileTree />
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
                      <TooltipContent>{t('etl.run_file')}</TooltipContent>
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
                      <TooltipContent>{t('etl.run_all')}</TooltipContent>
                    </Tooltip>
                    {isRunning && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon-xs" onClick={() => setIsRunning(false)}>
                            <Square size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('etl.stop')}</TooltipContent>
                      </Tooltip>
                    )}
                  </>
                )}

                <div className="ml-auto flex items-center gap-1">
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
                  {/* File tabs */}
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

                  {/* Separator */}
                  {openFileIds.length > 0 && outputTabOrder.length > 0 && (
                    <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                  )}

                  {/* Output tabs */}
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
                          <button
                            key={tabId}
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
                        )
                      }

                      const tab = outputTabs.find((ot) => ot.id === tabId)
                      if (!tab) return null

                      return (
                        <button
                          key={tab.id}
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
                <Allotment>
                  {/* Editor pane */}
                  <Allotment.Pane minSize={150} visible={editorVisible}>
                    {selectedFile ? (
                      <CodeEditor
                        key={selectedFileId}
                        value={selectedFile.content ?? ''}
                        language={editorLanguage}
                        onChange={(v) => updateFileContent(selectedFile.id, v ?? '')}
                        onSave={handleEditorSave}
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

                  {/* Output pane */}
                  <Allotment.Pane minSize={200} visible={outputVisible && hasOutput}>
                    <div className="flex h-full flex-col border-l">
                      <EtlOutputContent
                        activeOutputTab={activeOutputTab}
                        outputTabs={outputTabs}
                        executionResults={executionResults}
                      />
                    </div>
                  </Allotment.Pane>
                </Allotment>
              </div>
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {/* Create file dialog */}
      <Dialog open={createFileOpen} onOpenChange={setCreateFileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('etl.new_file')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label>{t('etl.file_name')}</Label>
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="01_person.sql"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile()
              }}
            />
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
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// EtlOutputContent — inline output panel reading from useEtlStore
// ---------------------------------------------------------------------------

function EtlOutputContent({
  activeOutputTab,
  outputTabs,
  executionResults,
}: {
  activeOutputTab: string | null
  outputTabs: EtlOutputTab[]
  executionResults: EtlExecutionResult[]
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
              <EtlResultCard key={result.id} result={result} />
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
// EtlResultCard — single execution result with copy + show-code toggle
// ---------------------------------------------------------------------------

function EtlResultCard({ result }: { result: EtlExecutionResult }) {
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
