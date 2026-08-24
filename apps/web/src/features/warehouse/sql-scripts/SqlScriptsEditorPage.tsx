import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
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
  Database,
  Copy,
  Check,
  Code,
  FileText,
  TableIcon,
  FolderPlus,
  ListChecks,
  Download,
  GitBranch,
  MoreHorizontal,
  Scale,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import { useUrlTab } from '@/hooks/use-url-tab'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useSqlCollectionActions } from './use-sql-collection-actions'
import { cn } from '@/lib/utils'
import type * as Monaco from 'monaco-editor'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { useSqlScriptsStore, type SqlOutputTab, type SqlExecutionResult } from '@/stores/sql-scripts-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { isServerMode } from '@/lib/api-client'
import { useDataSourceStore } from '@/stores/data-source-store'
import { SqlScriptsFileTree } from './SqlScriptsFileTree'
import { CreateSqlScriptFileDialog } from './CreateSqlScriptFileDialog'
import { SchemaBrowserDialog } from '@/features/warehouse/databases/SchemaBrowserDialog'
import { KeyboardShortcutsDialog } from '@/features/projects/files/KeyboardShortcutsDialog'
import { useGlobalShortcuts, type ShortcutHandlers } from '@/hooks/use-shortcuts'
import type { ShortcutActionId } from '@/types/shortcuts'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'

/** Shortcut actions surfaced in the SQL editor (subset of the IDE's set;
 * no terminal here, so no toggle/clear-terminal). */
const SQL_EDITOR_SHORTCUT_ACTIONS: ShortcutActionId[] = [
  'toggle_sidebar',
  'new_file',
  'save_file',
  'run_selection_or_line',
  'run_file',
  'toggle_comment',
]

const SQL_TAB_IDS = ['scripts', 'readme', 'license', 'versioning'] as const
type SqlTabId = (typeof SQL_TAB_IDS)[number]

/**
 * Readme, licence, export and versioning fold behind one trigger, as on the ETL
 * pipeline, the schema, the mapping project and the database.
 *
 * Scripts is the only primary tab: the editor is the page, and everything else
 * is what you reach for occasionally.
 *
 * 'export' is not a tab of its own — a collection exports as a ZIP download, so
 * selecting it runs the action and leaves the active tab alone.
 */
const SQL_SECONDARY_TABS = ['readme', 'license', 'versioning'] as const
type SqlSecondaryTabId = (typeof SQL_SECONDARY_TABS)[number]

function isSqlSecondaryTab(tab: SqlTabId): tab is SqlSecondaryTabId {
  return (SQL_SECONDARY_TABS as readonly string[]).includes(tab)
}

interface Props {
  collectionId: string
}

export function SqlScriptsEditorPage({ collectionId }: Props) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('sql-scripts:write')
  const {
    collections,
    collectionsLoaded,
    loadCollections,
    files,
    loadCollectionFiles,
    selectedFileId,
    openFileIds,
    selectFile,
    closeFile,
    updateFileContent,
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
    updateCollection,
  } = useSqlScriptsStore()

  const sqlActions = useSqlCollectionActions()
  const [activeTab, setActiveTab] = useUrlTab<SqlTabId>({
    key: `sql-collection:${collectionId}`,
    tabs: SQL_TAB_IDS,
    defaultTab: 'scripts',
  })

  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFolderMode, setCreateFolderMode] = useState(false)
  // Folder the create dialog targets (null = root). Set by the toolbar (root) or
  // a folder's right-click "New script / New folder" (that folder).
  const [createParentId, setCreateParentId] = useState<string | null>(null)
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [copiedRef, setCopiedRef] = useState<string | null>(null)

  const fileTabScrollRef = useRef<HTMLDivElement>(null)
  const outputTabScrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

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

  // The collection's own frozen provenance wins; otherwise the workspace's live
  // organization — the rule every other licence tab follows.
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === collection?.workspaceId))
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = collection?.organization?.name ?? org?.name
  const licenseHolder = holder ? localized(holder, i18n.language) : undefined

  const selectedFile = files.find((f) => f.id === selectedFileId)
  const hasOutput = outputTabs.length > 0 || executionResults.length > 0

  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const activeDbId = collection?.defaultDataSourceId ?? null
  const activeDb = activeDbId ? dbSources.find((ds) => ds.id === activeDbId) : undefined

  // Mount the active database
  useEffect(() => {
    if (!activeDbId) return
    const { testConnection } = useDataSourceStore.getState()
    testConnection(activeDbId)
  }, [activeDbId])

  // Open the create dialog targeting a folder (null = root).
  const openCreate = useCallback((parentId: string | null, folderMode: boolean) => {
    setCreateParentId(parentId)
    setCreateFolderMode(folderMode)
    setCreateFileOpen(true)
  }, [])

  // Execute SQL
  const executeSql = useCallback(
    async (sql: string, label: string) => {
      if (!activeDbId) {
        addExecutionResult({
          id: `exec-${Date.now()}`,
          fileName: label,
          timestamp: Date.now(),
          duration: 0,
          success: false,
          output: t('sql_scripts.no_database_selected'),
        })
        return
      }
      const { testConnection } = useDataSourceStore.getState()
      await testConnection(activeDbId)
      const start = Date.now()
      try {
        const rows = await duckdbEngine.queryDataSource(activeDbId, sql)
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
            label: t('sql_scripts.tab_result', { name: label }),
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
    [activeDbId, t, addExecutionResult, addOutputTab],
  )

  // Run a file: Markdown opens a rendered preview tab (no DB needed, same as the
  // IDE); everything else is executed as SQL against the active database.
  const runFile = useCallback(
    async (content: string, name: string) => {
      if (name.endsWith('.md')) {
        addOutputTab({
          id: `markdown-${name}`,
          label: t('sql_scripts.tab_preview', { name }),
          type: 'markdown',
          content,
        })
        setOutputVisible(true)
        return
      }
      await executeSql(content, name)
    },
    [addOutputTab, setOutputVisible, executeSql, t],
  )

  const handleRunFile = useCallback(async () => {
    if (!selectedFile?.content) return
    setIsRunning(true)
    try {
      await runFile(selectedFile.content, selectedFile.name)
    } finally {
      setIsRunning(false)
    }
  }, [selectedFile, runFile])

  // Cmd+Enter: run the selection if any, else the current line (RStudio-style).
  // Markdown has no partial run — it always renders the whole file (like Run file).
  const handleRunSelectionOrLine = useCallback(async () => {
    if (!selectedFile) return
    if (selectedFile.name.endsWith('.md')) {
      await handleRunFile()
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
      label = t('sql_scripts.label_selection', { name: selectedFile.name })
    } else {
      const pos = editor.getPosition()
      if (!pos) return
      sql = model.getLineContent(pos.lineNumber)
      label = `${selectedFile.name}:${pos.lineNumber}`
    }
    if (!sql.trim()) return
    setIsRunning(true)
    try {
      await executeSql(sql, label)
    } finally {
      setIsRunning(false)
    }
  }, [selectedFile, handleRunFile, executeSql, t])

  const handleRunAll = useCallback(async () => {
    const sqlFiles = files
      .filter((f) => f.type === 'file' && f.name.endsWith('.sql'))
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

  // Global shortcuts shared with the IDE (via the shortcut store). Editor-scoped
  // actions (save/run/find/replace/comment) are handled by Monaco in CodeEditor.
  const globalShortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      toggle_sidebar: () => setExplorerVisible((v) => !v),
      new_file: () => openCreate(null, false),
    }),
    [openCreate],
  )
  useGlobalShortcuts(globalShortcutHandlers)

  // Cmd+Shift+Enter = Run All (SQL-specific, not part of the IDE action set).
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
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as SqlTabId)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 items-center px-6 pt-2">
            <div className="flex-1" />
            <TabsList>
              <TabsTrigger value="scripts">
                <Code size={14} />
                {t('sql_scripts.tab_scripts')}
              </TabsTrigger>
              <SqlSecondaryTabsTrigger
                activeTab={activeTab}
                onSelect={setActiveTab}
                onExport={() => { if (collection) void sqlActions.onExport(collection) }}
              />
            </TabsList>
            <div className="flex-1" />
          </div>

          <TabsContent value="readme" className="m-0 min-h-0 flex-1 p-0">
            <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
              {collection && (
                <EntityReadmePanel
                  readme={collection.readme}
                  onSave={(readme) => updateCollection(collection.id, { readme })}
                  canEdit={canWrite}
                  attachmentOwner={{ type: 'sql-collection', id: collection.id, workspaceId: collection.workspaceId }}
                  // The tab already says "Readme".
                  showTitle={false}
                />
              )}
            </div>
          </TabsContent>

          <TabsContent value="license" className="m-0 min-h-0 flex-1 p-0">
            <div className="mx-auto flex h-full max-w-5xl flex-col px-6 pb-1.5">
              {collection && (
                <EntityLicensePanel
                  license={collection.license ?? null}
                  onSave={(license) => updateCollection(collection.id, { license: license ?? undefined })}
                  canEdit={canWrite}
                  copyrightHolder={licenseHolder}
                  showTitle={false}
                />
              )}
            </div>
          </TabsContent>

          <TabsContent value="versioning" className="m-0 min-h-0 flex-1 p-0">
            <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col px-6 py-6">
              {/* Git link + push-only sync panel. Export is a menu action here, so
                  no export UI in this tab. */}
              {collection && (
                <GitRepositoryTab
                  gitRemote={collection.gitRemoteConfig ?? null}
                  onSave={(cfg) => updateCollection(collection.id, { gitRemoteConfig: cfg ?? undefined })}
                  syncScope="sql-script-collections"
                  syncId={collection.id}
                />
              )}
            </div>
          </TabsContent>

        {/* The editor keeps its own mount across tab switches: Monaco, the open
            files and the output panes are expensive to rebuild, and coming back
            to a re-initialised editor would lose the session. */}
        <div className={cn('min-h-0 flex-1 overflow-hidden', activeTab === 'scripts' ? '' : 'hidden')}>
          <Allotment>
            {/* Explorer sidebar */}
            <Allotment.Pane preferredSize={240} minSize={140} maxSize={400} visible={explorerVisible}>
              <div className="flex h-full flex-col border-r">
                <div className="flex items-center justify-between border-b px-2 py-1.5">
                  <div className="flex items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={() => openCreate(null, false)}>
                          <FilePlus size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('sql_scripts.new_file')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={() => openCreate(null, true)}>
                          <FolderPlus size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('files.new_folder')}</TooltipContent>
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
                <SqlScriptsFileTree onNewChild={openCreate} />
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
                      {/* Run — split button (same UI as the IDE): primary runs the
                          current script, the dropdown adds "run all scripts". */}
                      {isRunning ? (
                        <Button size="xs" variant="destructive" className="gap-1" onClick={() => setIsRunning(false)}>
                          <Square size={12} />
                          {t('sql_scripts.stop')}
                        </Button>
                      ) : (
                        <div className="flex">
                          <Button size="xs" className="gap-1 rounded-r-none" disabled={!canWrite} onClick={handleRunFile}>
                            <Play size={12} />
                            {t('sql_scripts.run')}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="xs" className="rounded-l-none border-l border-primary-foreground/20 px-1">
                                <ChevronDown size={12} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem onClick={handleRunFile} className="gap-2 text-xs">
                                <FileCode size={13} className="text-muted-foreground" />
                                {t('sql_scripts.run_file')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={handleRunAll} className="gap-2 text-xs">
                                <ListChecks size={13} className="text-muted-foreground" />
                                {t('sql_scripts.run_all')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                      {/* Save current file (Cmd+S) */}
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
                        <TooltipContent>{t('sql_scripts.save')} (⌘S)</TooltipContent>
                      </Tooltip>
                    </>
                  )}

                  {/* Database selector — same picker UI as the IDE's RunButton. */}
                  <div className="mx-1 h-4 w-px bg-border" />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild disabled={dbSources.length === 0}>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={dbSources.length === 0}
                        className="gap-1 max-w-[160px] text-[11px]"
                      >
                        <Database size={11} className="shrink-0" />
                        <span className="truncate">
                          {dbSources.length === 0
                            ? t('sql_scripts.no_database_available')
                            : localized(activeDb?.name, i18n.language) || t('sql_scripts.select_database')}
                        </span>
                        <ChevronDown size={10} className="shrink-0 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-[200px]">
                      {dbSources.map((ds) => (
                        <DropdownMenuItem
                          key={ds.id}
                          onClick={() => updateCollection(collectionId, { defaultDataSourceId: ds.id })}
                          className="gap-2 py-1 text-xs"
                          title={localized(ds.name, i18n.language)}
                        >
                          <Database size={12} className="shrink-0 text-amber-500" />
                          <span className="truncate">{localized(ds.name, i18n.language)}</span>
                          {activeDbId === ds.id && <Check size={12} className="ml-auto shrink-0" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Browse the database schema — sits right after the DB picker. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setSchemaDialogOpen(true)}
                        disabled={!activeDbId}
                      >
                        <Table2 size={13} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('sql_scripts.browse_schema')}</TooltipContent>
                  </Tooltip>

                  {/* Copy schema reference — only meaningful in front-only mode,
                      where tables are addressed as "ds_<alias>".<table>. In server
                      mode the search_path is set server-side, so scripts use bare
                      table names (FROM patients) and there is no prefix to copy. */}
                  {!isServerMode() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!activeDbId}
                        onClick={() => {
                          if (!activeDbId) return
                          const ds = dataSources.find((d) => d.id === activeDbId)
                          const ref = `"ds_${ds?.alias ?? activeDbId.replace(/[^a-zA-Z0-9]/g, '_')}"`
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
                  )}

                  <div className="ml-auto flex items-center gap-1">
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
                            editorRef={editorRef}
                            value={selectedFile.content ?? ''}
                            language={selectedFile.name.endsWith('.md') ? 'markdown' : 'sql'}
                            onChange={(v) => updateFileContent(selectedFile.id, v ?? '')}
                            onSave={handleSaveFile}
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
        </Tabs>
      </div>

      {/* Create file/folder dialog — type + parent-folder picker, like the IDE. */}
      <CreateSqlScriptFileDialog
        open={createFileOpen}
        onOpenChange={setCreateFileOpen}
        collectionId={collectionId}
        parentId={createParentId}
        folderMode={createFolderMode}
      />

      {/* Unsaved changes dialog */}
      <DialogShell
        open={!!closeConfirmFileId}
        onOpenChange={(open) => { if (!open) setCloseConfirmFileId(null) }}
        title={t('files.unsaved_changes_title')}
        description={t('files.unsaved_changes_description', {
          name: files.find((f) => f.id === closeConfirmFileId)?.name ?? '',
        })}
        onConfirm={handleSaveAndClose}
        confirmLabel={t('common.save')}
        footerExtra={
          <Button variant="ghost" size="sm" onClick={handleDiscardAndClose}>{t('files.dont_save')}</Button>
        }
      >
        {null}
      </DialogShell>

      {/* Database schema browser */}
      {activeDbId && (
        <SchemaBrowserDialog
          open={schemaDialogOpen}
          onOpenChange={setSchemaDialogOpen}
          dataSourceId={activeDbId}
        />
      )}

      {/* Keyboard shortcuts dialog — same customizable dialog as the IDE,
          filtered to the actions relevant in the SQL editor. */}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        actionIds={SQL_EDITOR_SHORTCUT_ACTIONS}
      />
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Secondary tabs ("...")
// ---------------------------------------------------------------------------

/**
 * One trigger standing in for the occasional tabs.
 *
 * It is a real TabsTrigger for whichever of them is active, so the tab
 * semantics are the ones Radix provides; when none is active it only opens the
 * menu.
 */
function SqlSecondaryTabsTrigger({
  activeTab,
  onSelect,
  onExport,
}: {
  activeTab: SqlTabId
  onSelect: (tab: SqlTabId) => void
  onExport: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = isSqlSecondaryTab(activeTab) ? activeTab : undefined

  // Export downloads a ZIP rather than opening a view, so it has no tab id and
  // never becomes the active one — it sits here because this is where the
  // occasional actions live.
  const items: { id: SqlSecondaryTabId | 'export'; label: string; icon: typeof FileText }[] = [
    { id: 'readme', label: t('common.readme'), icon: FileText },
    { id: 'license', label: t('license.title'), icon: Scale },
    { id: 'export', label: t('common.export'), icon: Download },
    { id: 'versioning', label: t('common.versioning'), icon: GitBranch },
  ]
  const current = items.find((i) => i.id === active)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <TabsTrigger
          value={active ?? '__secondary__'}
          // TabsTrigger paints "active" from data-state, but DropdownMenuTrigger
          // owns that attribute on a composed trigger and writes open/closed into
          // it. aria-selected stays the tab's own, so drive the styles off that.
          className="aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
          // The menu is the point: let it open instead of switching tab.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.preventDefault(); setOpen((v) => !v) }}
        >
          {current ? <current.icon size={14} /> : <MoreHorizontal size={14} />}
          {current ? current.label : t('common.more')}
          <ChevronDown size={12} className="opacity-60" />
        </TabsTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => { if (item.id === 'export') onExport(); else onSelect(item.id) }}
            className={item.id === active ? 'bg-accent' : undefined}
          >
            <item.icon size={14} className="text-muted-foreground" />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
      {!isConsoleTab && activeTab?.type === 'markdown' && (
        <ScrollArea className="h-full">
          <MarkdownRenderer content={String(activeTab.content)} className="p-4" />
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
