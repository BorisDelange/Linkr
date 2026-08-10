import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { isReservedTreeName, reservedTreeNameReason } from '@/lib/entity-tree'
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
  Square,
  Save,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  X,
  Table2,
  Keyboard,
  ListChecks,
  TextSelect,
  CornerDownLeft,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { cn } from '@/lib/utils'
import type * as Monaco from 'monaco-editor'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { TableIcon, FileText, Copy, Code, Check, Database } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useEtlStore, type EtlOutputTab, type EtlExecutionResult } from '@/stores/etl-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useRoleSchemas } from './use-role-schemas'
import { usePipelineRunner } from './use-pipeline-runner'
import { RunAbortedError } from './run-pipeline-sql'
import { EtlUploadDialog } from './EtlUploadDialog'
import { inferEtlLanguage } from './etl-file-language'
import { RunProgressBar } from './RunProgressBar'
import { statementLineAt } from './statement-preview'
import { csvDelimiterFor, parseCsvPreview } from '@/lib/csv-preview'
import { formatTimeLocale } from '@/lib/format-helpers'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { compareByRole } from './role-presentation'
import { PipelineDbPicker } from './PipelineDbPicker'
import { useDataSourceStore } from '@/stores/data-source-store'
import { KeyboardShortcutsDialog } from '@/features/projects/files/KeyboardShortcutsDialog'
import { useGlobalShortcuts, type ShortcutHandlers } from '@/hooks/use-shortcuts'
import { useShortcutStore } from '@/stores/shortcut-store'
import { comboToString } from '@/lib/format-shortcut'
import type { KeyCombo, ShortcutActionId } from '@/types/shortcuts'
import { EtlFileTree } from './EtlFileTree'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import type { EtlFile } from '@/types'

/** Shortcut actions surfaced in the ETL editor (subset of the IDE's set;
 * no terminal here, so no toggle/clear-terminal). */
const ETL_EDITOR_SHORTCUT_ACTIONS: ShortcutActionId[] = [
  'toggle_sidebar',
  'new_file',
  'save_file',
  'run_selection_or_line',
  'run_file',
  'toggle_comment',
]

/** Run-all lives outside the rebindable shortcut set, so its combo is declared
 *  once here and used both to match the keypress and to label the menu item. */
const RUN_ALL_COMBO: KeyCombo = { key: 'Enter', ctrlOrMeta: true, shift: true, alt: false }

const ETL_FILE_TYPES = [
  { id: 'sql', label: 'SQL', ext: '.sql', lang: 'sql' as const, icon: Database, iconColor: 'text-blue-500' },
  { id: 'py', label: 'Python', ext: '.py', lang: 'python' as const, icon: FileCode, iconColor: 'text-yellow-500' },
  { id: 'r', label: 'R', ext: '.R', lang: 'r' as const, icon: FileCode, iconColor: 'text-sky-500' },
  { id: 'md', label: 'Markdown', ext: '.md', lang: 'markdown' as const, icon: FileText, iconColor: 'text-muted-foreground' },
]

/** A documentation file: Run PREVIEWS it (as in the project IDE) instead of
 *  sending it to DuckDB, which would only raise a SQL parse error. */
function isMarkdownFile(file: EtlFile): boolean {
  return file.language === 'markdown' || file.name.toLowerCase().endsWith('.md')
}

/** Sent to DuckDB when run. Markdown is not: it gets a preview instead. */
function isExecutable(file: EtlFile): boolean {
  return !isMarkdownFile(file)
}

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
  /** Show a database's tables in the Schemas tab (same view, no modal). */
  onBrowseSchema?: (dataSourceId: string) => void
}

export function EtlScriptsTab({ pipelineId, onBrowseSchema }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const {
    files,
    selectedFileId,
    openFileIds,
    selectFile,
    closeFile,
    reorderOpenFiles,
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
  const [uploadOpen, setUploadOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFileType, setNewFileType] = useState('sql')
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Tab drag-reorder, same interaction as the project IDE's file tabs.
  const [dragFileId, setDragFileId] = useState<string | null>(null)
  const [dropFileInsert, setDropFileInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)

  // Same bindings the IDE's Run button shows, read from the shortcut store so a
  // rebind is reflected in both places.
  const runFileKey = useShortcutStore((s) => comboToString(s.shortcuts.run_file.binding))
  const runLineKey = useShortcutStore((s) => comboToString(s.shortcuts.run_selection_or_line.binding))
  // Run-all is an ETL-specific chord with no entry in the shortcut store; format
  // it the same way so the menu reads consistently on Mac and Windows.
  const runAllKey = comboToString(RUN_ALL_COMBO)

  // Tab scroll refs
  const fileTabScrollRef = useRef<HTMLDivElement>(null)
  const outputTabScrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  const scrollTabs = useCallback((ref: React.RefObject<HTMLDivElement | null>, dir: 'left' | 'right') => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  const selectedFile = files.find((f) => f.id === selectedFileId)
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const { roleOf, dataSourceIdOf } = useRoleSchemas(pipeline)
  const { runScripts, runOne, stop: stopRun, running: busy } = usePipelineRunner(pipeline)

  /** The scripts a Run-all covers, in execution order. Disabled ones stay in so
   *  the run log records them as skipped rather than dropping them silently. */
  const orderedSqlFiles = useMemo(() => (
    files
      .filter((f) => f.type === 'file' && (f.language === 'sql' || f.name.endsWith('.sql')))
      .sort((a, b) => a.order - b.order)
  ), [files])

  // Only the pipeline's own databases — its two roles plus the ATHENA reference
  // of its mapping project. Unrelated vocabulary DBs of the workspace are not
  // reachable from these scripts, so listing them would be misleading.
  const pipelineDbs = [...new Set([
    pipeline?.sourceDataSourceId,
    pipeline?.targetDataSourceId,
    dataSourceIdOf('vocab'),
  ].filter(Boolean) as string[])]
    .map((id) => dataSources.find((ds) => ds.id === id))
    .filter((ds): ds is NonNullable<typeof ds> => !!ds)
    // source, target, vocab — same order as the Schemas tab picker.
    .sort((a, b) => compareByRole(a.id, b.id, roleOf))

  // Where an unqualified statement is aimed. Since roles carry the addressing
  // (`source.` / `target.` / `vocab.` resolve from the pipeline), this is just a
  // convenience for the current session: not stored per file, and reset to the
  // source each time the pipeline is opened.
  const [runOnId, setRunOnId] = useState<string | undefined>(undefined)
  const activeDbId = [runOnId, pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId]
    .find((id) => id && pipelineDbs.some((ds) => ds.id === id))
    ?? pipelineDbs[0]?.id

  const resolveFileDataSourceId = useCallback(
    (_file: EtlFile | undefined): string | undefined => activeDbId,
    [activeDbId],
  )

  const selectedFileRole = roleOf(activeDbId)


  // Ensure source + target + vocabulary data sources are mounted in DuckDB when pipeline loads
  const ensurePipelineDbsMounted = useCallback(async () => {
    const { testConnection, dataSources: allDs } = useDataSourceStore.getState()
    if (pipeline?.sourceDataSourceId) await testConnection(pipeline.sourceDataSourceId)
    if (pipeline?.targetDataSourceId) await testConnection(pipeline.targetDataSourceId)
    // Mount vocabulary reference databases (needed by 00_vocabulary.sql)
    const vocabSources = allDs.filter((ds) => ds.isVocabularyReference && ds.status === 'connected')
    for (const vs of vocabSources) {
      await testConnection(vs.id)
    }
  }, [pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId])

  useEffect(() => {
    ensurePipelineDbsMounted()
  }, [ensurePipelineDbsMounted])

  const editorLanguage = useMemo(() => {
    if (!selectedFile) return 'plaintext'
    if (selectedFile.language) return selectedFile.language
    return inferEtlLanguage(selectedFile.name) ?? 'plaintext'
  }, [selectedFile])

  /**
   * Selecting a CSV/TSV opens it as a table in the output panel, as the IDE does.
   * A pipeline holds data beside its scripts — the mapping export above all — and
   * reading 1394 comma-separated lines in the editor is not reading them.
   */
  useEffect(() => {
    if (!selectedFile || selectedFile.type !== 'file') return
    const delimiter = csvDelimiterFor(selectedFile.name)
    if (!delimiter) return
    const preview = parseCsvPreview(selectedFile.content ?? '', delimiter)
    if (!preview) return
    addOutputTab({
      id: `csv-preview:${selectedFile.id}`,
      label: selectedFile.name,
      type: 'table',
      content: { headers: preview.headers, rows: preview.rows },
    })
    setOutputVisible(true)
  }, [selectedFile, addOutputTab, setOutputVisible])

  // Create new file
  /**
   * The name the file would actually get, and whether it is already taken.
   *
   * Checked on the RESOLVED name, after the extension is appended: typing
   * "00_vocabulary" when 00_vocabulary.sql exists is the same clash, and testing
   * the raw input would miss it.
   */
  const newFileResolved = useMemo(() => {
    const typed = newFileName.trim()
    if (!typed) return { name: '', clashes: false }
    const ext = (ETL_FILE_TYPES.find((ft) => ft.id === newFileType) ?? ETL_FILE_TYPES[0]).ext
    const name = typed.includes('.') ? typed : `${typed}${ext}`
    // Top level only: the dialog creates at the root (parentId null).
    const clashes = files.some(
      (f) => f.parentId === null && f.name.toLowerCase() === name.toLowerCase(),
    )
    return { name, clashes, reserved: isReservedTreeName(name, null) }
  }, [newFileName, newFileType, files])

  const handleCreateFile = async () => {
    const name = newFileResolved.name
    // Refused rather than silently de-duplicated: two files with one name at the
    // same path make the export tree ambiguous and the run order unreadable.
    if (!name || newFileResolved.clashes || newFileResolved.reserved) return
    const selectedType = ETL_FILE_TYPES.find((ft) => ft.id === newFileType) ?? ETL_FILE_TYPES[0]
    const lang = inferEtlLanguage(name) ?? selectedType.lang
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
    setNewFileType('sql')
  }

  // Execute SQL against a data source. Goes through the shared runner, which owns
  // the run state: the toolbar can stop it, and switching tabs no longer makes an
  // in-flight run look finished (that state used to be local to this component).
  const executeSql = useCallback(
    async (fileId: string, sql: string, label: string, dataSourceId?: string) => {
      const dsId = dataSourceId ?? pipeline?.targetDataSourceId
      if (!dsId) return
      const start = Date.now()
      try {
        const rows = await runOne(fileId, sql, dsId)
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
          // A stop is reported as such rather than as a SQL failure, and never
          // opens a Result tab: the rows of a half-run script are not the answer.
          success: false,
          output: err instanceof RunAbortedError
            ? t('etl.run_stopped')
            : err instanceof Error ? err.message : String(err),
          code: sql,
        })
      }
    },
    [pipeline?.targetDataSourceId, runOne, addExecutionResult, addOutputTab, t],
  )

  /**
   * Markdown has no partial run: whatever the trigger, render the whole file.
   * Mirrors the project IDE, where Run on a .md opens a preview tab.
   */
  const previewMarkdown = useCallback((file: EtlFile) => {
    addOutputTab({
      id: `markdown-${file.name}`,
      label: `${t('etl.preview')} — ${file.name}`,
      type: 'markdown',
      content: file.content ?? '',
    })
    setOutputVisible(true)
  }, [addOutputTab, setOutputVisible, t])

  // Run current file
  const handleRunFile = useCallback(async () => {
    if (!selectedFile?.content) return
    if (isMarkdownFile(selectedFile)) {
      previewMarkdown(selectedFile)
      return
    }
    await executeSql(
      selectedFile.id, selectedFile.content, selectedFile.name,
      resolveFileDataSourceId(selectedFile),
    )
  }, [selectedFile, executeSql, resolveFileDataSourceId, previewMarkdown])

  // Cmd+Enter: run the selection if any, else the current line (RStudio-style).
  const handleRunSelectionOrLine = useCallback(async () => {
    if (!selectedFile) return
    if (isMarkdownFile(selectedFile)) {
      previewMarkdown(selectedFile)
      return
    }
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const selection = editor.getSelection()
    let sql = ''
    let label = selectedFile.name
    if (selection && !selection.isEmpty()) {
      sql = model.getValueInRange(selection)
      label = `${selectedFile.name} (selection)`
    } else {
      const pos = editor.getPosition()
      if (!pos) return
      sql = model.getLineContent(pos.lineNumber)
      label = `${selectedFile.name}:${pos.lineNumber}`
    }
    if (!sql.trim()) return
    await executeSql(selectedFile.id, sql, label, resolveFileDataSourceId(selectedFile))
  }, [selectedFile, executeSql, resolveFileDataSourceId, previewMarkdown])

  /**
   * Jump to the statement a run is executing: open its script if needed, then
   * put the cursor on the line. Lets "Query 10/26" answer "which one is that?"
   * without hunting through a 300-line generated file.
   */
  const goToStatement = useCallback((fileId: string, statementIndex: number | undefined) => {
    const file = files.find((f) => f.id === fileId)
    if (!file) return
    if (fileId !== selectedFileId) selectFile(fileId)
    // After a selectFile the editor may still hold the previous model, so the
    // reveal waits for the swap rather than scrolling the wrong file.
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      // The buffer, not file.content: an unsaved edit shifts every line below it,
      // and the run reports indices against what the editor is showing.
      const sql = editor.getModel()?.getValue() ?? file.content ?? ''
      const line = statementLineAt(sql, statementIndex)
      if (line == null) return
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
      editor.focus()
    })
  }, [files, selectedFileId, selectFile])

  // Run every script, through the same runner as the Pipeline tab: this used to
  // be a silent local loop, so a Run-all here showed a spinner and nothing else.
  const handleRunAll = useCallback(async () => {
    if (orderedSqlFiles.length === 0) return
    await runScripts(orderedSqlFiles)
  }, [orderedSqlFiles, runScripts])

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

  // Run All (ETL-specific chord, outside the shared IDE action set — Monaco
  // handles save/run/find/replace/comment). Matched against the same combo the
  // menu displays, so the label cannot drift from the binding.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === RUN_ALL_COMBO.key) {
        e.preventDefault()
        handleRunAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleRunAll])

  // Global shortcuts shared with the IDE (via the shortcut store). The editor's
  // sidebar toggle is the only page-level action; the rest are Monaco-scoped.
  const globalShortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      toggle_sidebar: () => setExplorerVisible((v) => !v),
      new_file: () => setCreateFileOpen(true),
    }),
    [],
  )
  useGlobalShortcuts(globalShortcutHandlers)

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
                      <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={() => setCreateFileOpen(true)}>
                        <FilePlus size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('etl.new_file')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={() => setUploadOpen(true)}>
                        <Upload size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('etl.upload_files')}</TooltipContent>
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
                    {/* Markdown gets a plain Preview: it has no partial run, so the
                        split menu's "run selection / line" would be a lie. */}
                    {!isExecutable(selectedFile) ? (
                      <Button size="xs" className="gap-1" onClick={handleRunFile}>
                        <Eye size={12} />
                        {t('etl.preview')}
                      </Button>
                    ) : (
                    <>
                        {/* Run — split button (same UI as SQL script collections). */}
                        {busy ? (
                          <Button
                            size="xs"
                            variant="destructive"
                            className="gap-1"
                            onClick={stopRun}
                          >
                            <Square size={12} />
                            {t('etl.stop')}
                          </Button>
                        ) : (
                          <div className="flex">
                            <Button size="xs" className="gap-1 rounded-r-none" onClick={handleRunFile} disabled={!canWrite}>
                              <Play size={12} />
                              {t('etl.run')}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="xs" className="rounded-l-none border-l border-primary-foreground/20 px-1" disabled={!canWrite}>
                                  <ChevronDown size={12} />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={handleRunFile} className="gap-2 text-xs">
                                  <FileCode size={13} className="text-muted-foreground" />
                                  {t('etl.run_file')}
                                  {runFileKey && <DropdownMenuShortcut>{runFileKey}</DropdownMenuShortcut>}
                                </DropdownMenuItem>
                                {/* One chord (⌘Enter) covers both: selection when there
                                    is one, else the current line — so it shows on both. */}
                                <DropdownMenuItem onClick={handleRunSelectionOrLine} className="gap-2 text-xs">
                                  <TextSelect size={13} className="text-muted-foreground" />
                                  {t('etl.run_selection')}
                                  {runLineKey && <DropdownMenuShortcut>{runLineKey}</DropdownMenuShortcut>}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={handleRunSelectionOrLine} className="gap-2 text-xs">
                                  <CornerDownLeft size={13} className="text-muted-foreground" />
                                  {t('etl.run_line')}
                                  {runLineKey && <DropdownMenuShortcut>{runLineKey}</DropdownMenuShortcut>}
                                </DropdownMenuItem>
                                {/* Below the separator sits the whole-pipeline action,
                                    where the IDE puts "run as background job". */}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={handleRunAll} className="gap-2 text-xs">
                                  <ListChecks size={13} className="text-muted-foreground" />
                                  {t('etl.run_all')}
                                  <DropdownMenuShortcut>{runAllKey}</DropdownMenuShortcut>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        )}
                        <RunProgressBar files={orderedSqlFiles} onGoToStatement={goToStatement} />
                    </>
                    )}
                    {/* Save current file (Cmd+S) — after Run */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={handleSaveFile}
                          disabled={_dirtyVersion < 0 || !isFileDirty(selectedFile.id) || !canWrite}
                        >
                          <Save size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('etl.save')} (⌘S)</TooltipContent>
                    </Tooltip>

                    {/* Which database an unqualified statement is aimed at. Session
                        state, not saved per file — the roles carry the addressing. */}
                    {pipelineDbs.length > 0 && (
                    <>
                    <div className="mx-1 h-4 w-px bg-border" />
                    <PipelineDbPicker
                      databases={pipelineDbs}
                      selectedId={activeDbId}
                      onSelect={setRunOnId}
                      roleOf={roleOf}
                    />

                    {/* Opens the Schemas tab on this database rather than a modal
                        over the editor — it is the same browser either way. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => {
                            const dsId = resolveFileDataSourceId(selectedFile)
                            if (dsId) onBrowseSchema?.(dsId)
                          }}
                          disabled={!resolveFileDataSourceId(selectedFile) || !onBrowseSchema}
                        >
                          <Table2 size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {resolveFileDataSourceId(selectedFile)
                          ? t('etl.browse_schema')
                          : t('etl.browse_schema_no_target')}
                      </TooltipContent>
                    </Tooltip>

                    {/* Copy the qualifier of the database picked in the dropdown.
                        Only the two pipeline roles have one — a vocabulary DB has no
                        role, so no prefix is offered for it (it stays addressable by
                        its own schema). Resolved at run time (lib/duckdb/role-prefix). */}
                    {selectedFileRole && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="gap-1 font-mono text-[10px]"
                            onClick={() => void navigator.clipboard.writeText(`${selectedFileRole}.`)}
                          >
                            <Copy size={10} className="shrink-0" />
                            {selectedFileRole}.
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t('etl.copy_prefix_tooltip', { role: selectedFileRole })}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    </>
                    )}
                  </>
                )}

                <div className="ml-auto flex items-center gap-1">
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
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('etl-file-tab-id', fid)
                                e.dataTransfer.effectAllowed = 'move'
                                setDragFileId(fid)
                              }}
                              onDragOver={(e) => {
                                if (!e.dataTransfer.types.includes('etl-file-tab-id')) return
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
                                const draggedId = e.dataTransfer.getData('etl-file-tab-id')
                                if (!draggedId || draggedId === fid) return
                                const fromIdx = openFileIds.indexOf(draggedId)
                                let toIdx = openFileIds.indexOf(fid)
                                if (side === 'right') toIdx++
                                // Removing the dragged tab first shifts every later
                                // index down by one.
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
                                <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-primary" />
                              )}
                              {dropFileInsert?.id === fid && dropFileInsert.side === 'right' && dragFileId !== fid && (
                                <div className="absolute right-0 top-1 bottom-1 w-0.5 rounded-full bg-primary" />
                              )}
                              <FileTypeIcon name={file.name} size={12} />
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
                              <ContextMenuItem onClick={() => {
                                for (const id of outputTabOrder) {
                                  if (id !== tabId) {
                                    if (id === '__exec_console__') clearExecutionResults()
                                    else closeOutputTab(id)
                                  }
                                }
                              }}>{t('files.close_others')}</ContextMenuItem>
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
                            <ContextMenuItem onClick={() => closeOutputTab(tab.id)}>{t('files.close')}</ContextMenuItem>
                            <ContextMenuItem onClick={() => {
                              for (const id of outputTabOrder) {
                                if (id === '__exec_console__') clearExecutionResults()
                                else closeOutputTab(id)
                              }
                            }}>{t('files.close_all')}</ContextMenuItem>
                            <ContextMenuItem onClick={() => {
                              for (const id of outputTabOrder) {
                                if (id !== tab.id) {
                                  if (id === '__exec_console__') clearExecutionResults()
                                  else closeOutputTab(id)
                                }
                              }
                            }}>{t('files.close_others')}</ContextMenuItem>
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
                {/* key forces remount so defaultSizes are re-applied on toggle */}
                <Allotment key={`eo-${editorVisible}-${outputVisible && hasOutput}`}>
                  {editorVisible && (
                    <Allotment.Pane minSize={150}>
                      {selectedFile ? (
                        <CodeEditor
                          key={selectedFileId}
                          editorRef={editorRef}
                          value={selectedFile.content ?? ''}
                          language={editorLanguage}
                          onChange={(v) => updateFileContent(selectedFile.id, v ?? '')}
                          onSave={handleEditorSave}
                          onRunFile={handleRunFile}
                          onRunSelectionOrLine={handleRunSelectionOrLine}
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
                        <EtlOutputContent
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

      {/* Create file dialog */}
      <EtlUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        pipelineId={pipelineId}
      />

      <Dialog open={createFileOpen} onOpenChange={setCreateFileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('etl.new_file')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('files.file_type')}</Label>
              <Select value={newFileType} onValueChange={setNewFileType}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ETL_FILE_TYPES.map((ft) => {
                    const Icon = ft.icon
                    return (
                      <SelectItem key={ft.id} value={ft.id}>
                        <div className="flex items-center gap-2">
                          <Icon size={14} className={ft.iconColor} />
                          <span>
                            {ft.label}{' '}
                            <span className="text-muted-foreground">({ft.ext})</span>
                          </span>
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('etl.file_name')}</Label>
              <Input
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder={`01_person${ETL_FILE_TYPES.find((ft) => ft.id === newFileType)?.ext ?? '.sql'}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleCreateFile() }
                }}
                aria-invalid={newFileResolved.clashes || newFileResolved.reserved}
                autoFocus
              />
              {newFileResolved.reserved && (
                <p className="text-xs text-destructive">{t(reservedTreeNameReason(newFileResolved.name))}</p>
              )}
              {newFileResolved.clashes && (
                <p className="text-xs text-destructive">
                  {t('etl.name_exists', { name: newFileResolved.name })}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFileOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateFile} disabled={!newFileName.trim() || newFileResolved.clashes || newFileResolved.reserved}>
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

      {/* Keyboard shortcuts dialog — same customizable dialog as the IDE,
          filtered to the actions relevant in the ETL editor. */}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        actionIds={ETL_EDITOR_SHORTCUT_ACTIONS}
      />
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
      {!isConsoleTab && activeTab?.type === 'markdown' && (
        <ScrollArea className="h-full">
          <MarkdownRenderer content={String(activeTab.content)} className="p-4" />
        </ScrollArea>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// EtlResultCard — single execution result with copy + show-code toggle
// ---------------------------------------------------------------------------

function EtlResultCard({ result }: { result: EtlExecutionResult }) {
  const { t, i18n } = useTranslation()
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
            {formatTimeLocale(result.timestamp, i18n.language)}
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

