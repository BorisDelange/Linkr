import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  FilePlus,
  FolderPlus,
  Upload,
  PanelLeft,
  PanelRight,
  Undo2,
  X,
  Table2,
  Plus,
  Eye,
  EyeOff,
  BarChart3,
  Pencil,
  Trash2,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { useAppStore } from '@/stores/app-store'
import { DatasetFileTree } from './datasets/DatasetFileTree'
import { DatasetTable } from './datasets/DatasetTable'
import { ColumnStatsPanel } from './datasets/ColumnStatsPanel'
import { AnalysesPanel } from './datasets/AnalysesPanel'
import { CreateDatasetDialog } from './datasets/CreateDatasetDialog'
import { CreateFolderDialog } from './datasets/CreateFolderDialog'
import { UploadDatasetDialog } from './datasets/UploadDatasetDialog'
import { CreateAnalysisDialog } from './datasets/CreateAnalysisDialog'
import { getAnalysisPlugin } from '@/lib/analysis-plugins/registry'
import type { AnalysisLanguage } from '@/types'

const LANG_BADGE: Record<string, { label: string; color: string }> = {
  python: { label: 'PY', color: 'text-blue-500 bg-blue-500/10' },
  r: { label: 'R', color: 'text-orange-500 bg-orange-500/10' },
  'js-widget': { label: 'JS', color: 'text-emerald-500 bg-emerald-500/10' },
}

function LanguageBadge({ language, type }: { language?: AnalysisLanguage; type: string }) {
  // Infer from plugin if not set
  let lang = language
  if (!lang) {
    const plugin = getAnalysisPlugin(type)
    if (plugin) {
      const rt = plugin.manifest.runtime
      if (rt.length === 1 && rt[0] === 'js-widget') lang = 'js-widget'
      else if (rt.includes('script') && plugin.manifest.languages.length > 0) lang = plugin.manifest.languages[0]
    }
  }
  if (!lang) return null
  const badge = LANG_BADGE[lang]
  if (!badge) return null
  return (
    <span className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none', badge.color)}>
      {badge.label}
    </span>
  )
}

export function DatasetsPage() {
  const { t } = useTranslation()
  const {
    files,
    selectedFileId,
    openFileIds,
    selectFile,
    closeFile,
    reorderOpenFiles,
    loadProjectDatasets,
    loadFileData,
    loadAnalyses,
    peekUndo,
    performUndo,
    isFileDirty,
    saveFile,
    revertFile,
    analyses,
    openAnalysisIds,
    selectedAnalysisId,
    selectAnalysis,
    closeAnalysis,
    deleteAnalysis,
    renameAnalysis,
    _dirtyVersion,
  } = useDatasetStore()
  const { activeProjectUid } = useAppStore()

  const [createDatasetOpen, setCreateDatasetOpen] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [createAnalysisOpen, setCreateAnalysisOpen] = useState(false)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [dataTableVisible, setDataTableVisible] = useState(true)
  const [statsVisible, setStatsVisible] = useState(true)
  const [dragFileId, setDragFileId] = useState<string | null>(null)
  const [dropFileTarget, setDropFileTarget] = useState<string | null>(null)
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null)
  const [renamingAnalysisId, setRenamingAnalysisId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  // Load datasets when the project changes
  useEffect(() => {
    if (activeProjectUid) {
      loadProjectDatasets(activeProjectUid)
    }
  }, [activeProjectUid, loadProjectDatasets])

  // Load file data and analyses when selected file changes
  useEffect(() => {
    if (selectedFileId) {
      loadFileData(selectedFileId)
      loadAnalyses(selectedFileId)
      setSelectedColumnId(null)
      setDataTableVisible(true)
    }
  }, [selectedFileId, loadFileData, loadAnalyses])

  // React to analysis selection changes (e.g. from createAnalysis auto-select)
  useEffect(() => {
    if (selectedAnalysisId) {
      setDataTableVisible(false)
      setStatsVisible(false)
    }
  }, [selectedAnalysisId])

  const selectedFile = files.find((f) => f.id === selectedFileId && f.type === 'file')
  const undoAction = peekUndo()

  // Determine parent folder from current selection (for create dialogs)
  const selectedParentId = useMemo(() => {
    if (!selectedFileId) return null
    const node = files.find((f) => f.id === selectedFileId)
    if (!node) return null
    return node.type === 'folder' ? node.id : node.parentId
  }, [selectedFileId, files])

  // Cmd+S: save active file
  const handleSaveFile = useCallback(() => {
    if (!selectedFileId) return
    saveFile(selectedFileId)
  }, [selectedFileId, saveFile])

  // Close file with unsaved changes confirmation
  const handleCloseFile = useCallback(
    (fid: string) => {
      if (isFileDirty(fid)) {
        setCloseConfirmFileId(fid)
      } else {
        closeFile(fid)
      }
    },
    [isFileDirty, closeFile]
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

  // Close file tab helpers
  const handleCloseOtherFiles = useCallback((keepId: string) => {
    for (const fid of openFileIds) {
      if (fid !== keepId) closeFile(fid)
    }
  }, [openFileIds, closeFile])

  const handleCloseAllFiles = useCallback(() => {
    for (const fid of openFileIds) closeFile(fid)
  }, [openFileIds, closeFile])

  // Close analysis tab helpers
  const handleCloseAnalysis = useCallback((id: string) => {
    const wasSelected = selectedAnalysisId === id
    closeAnalysis(id)
    if (wasSelected) {
      setDataTableVisible(true)
    }
  }, [selectedAnalysisId, closeAnalysis])

  const handleCloseOtherAnalyses = useCallback((keepId: string) => {
    const state = useDatasetStore.getState()
    for (const aid of state.openAnalysisIds) {
      if (aid !== keepId) closeAnalysis(aid)
    }
  }, [closeAnalysis])

  const handleCloseAllAnalyses = useCallback(() => {
    const state = useDatasetStore.getState()
    for (const aid of state.openAnalysisIds) {
      closeAnalysis(aid)
    }
    setDataTableVisible(true)
  }, [closeAnalysis])

  // Analysis rename helpers
  const handleStartAnalysisRename = useCallback((id: string, name: string) => {
    setRenamingAnalysisId(id)
    setRenameDraft(name)
  }, [])

  const handleFinishAnalysisRename = useCallback(() => {
    if (renamingAnalysisId && renameDraft.trim()) {
      renameAnalysis(renamingAnalysisId, renameDraft.trim())
    }
    setRenamingAnalysisId(null)
  }, [renamingAnalysisId, renameDraft, renameAnalysis])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+S: save active file
      if (isMod && e.key === 's') {
        e.preventDefault()
        handleSaveFile()
        return
      }

      // Cmd+Z: undo last tree action
      if (isMod && e.key === 'z' && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (undoAction) {
          e.preventDefault()
          performUndo()
        }
        return
      }

      // Cmd+N: open create dataset dialog
      if (isMod && e.key === 'n') {
        e.preventDefault()
        setCreateDatasetOpen(true)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSaveFile, undoAction, performUndo])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full overflow-hidden">
        <Allotment>
          {/* Explorer sidebar */}
          <Allotment.Pane
            preferredSize={240}
            minSize={140}
            maxSize={400}
            visible={explorerVisible}
          >
            <div className="flex h-full flex-col border-r">
              {/* Datasets header */}
              <div className="flex items-center justify-between border-b px-2 py-1.5">
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setCreateDatasetOpen(true)}
                      >
                        <FilePlus size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('datasets.new_dataset')}</TooltipContent>
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
                    <TooltipContent>{t('datasets.new_folder')}</TooltipContent>
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
                    <TooltipContent>{t('datasets.upload')}</TooltipContent>
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

              {/* Top half: dataset file tree */}
              <div className="min-h-0 flex-1 overflow-hidden">
                <DatasetFileTree />
              </div>

              {/* Bottom half: analyses for selected dataset */}
              <div className="flex min-h-[120px] flex-col border-t" style={{ flexBasis: '40%', flexShrink: 0 }}>
                {/* Analyses header bar */}
                <div className="flex items-center justify-between border-b px-2 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('datasets.analyses')}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setCreateAnalysisOpen(true)}
                        disabled={!selectedFileId}
                      >
                        <Plus size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('datasets.new_analysis')}</TooltipContent>
                  </Tooltip>
                </div>

                {/* Analyses list */}
                <ScrollArea className="flex-1">
                  {!selectedFileId ? (
                    <div className="flex items-center justify-center p-4 text-center">
                      <p className="text-xs text-muted-foreground">
                        {t('datasets.no_analyses_select_dataset')}
                      </p>
                    </div>
                  ) : analyses.length === 0 ? (
                    <div className="flex flex-col items-center justify-center p-4 text-center">
                      <p className="text-xs text-muted-foreground">
                        {t('datasets.no_analyses')}
                      </p>
                    </div>
                  ) : (
                    <div className="py-1">
                      {analyses.map((analysis) => {
                        const isActive = analysis.id === selectedAnalysisId
                        return (
                          <ContextMenu key={analysis.id}>
                            <ContextMenuTrigger asChild>
                              <button
                                onClick={() => {
                                  const newId = isActive ? null : analysis.id
                                  selectAnalysis(newId)
                                  if (newId) {
                                    setDataTableVisible(false)
                                    setStatsVisible(false)
                                  } else {
                                    setDataTableVisible(true)
                                  }
                                }}
                                onDoubleClick={() => handleStartAnalysisRename(analysis.id, analysis.name)}
                                className={cn(
                                  'group flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs transition-colors hover:bg-accent/50',
                                  isActive && 'bg-accent text-accent-foreground',
                                )}
                              >
                                <BarChart3 size={14} className="shrink-0 text-violet-500" />
                                {renamingAnalysisId === analysis.id ? (
                                  <input
                                    autoFocus
                                    className="flex-1 border-0 bg-transparent text-xs outline-none border-b border-primary"
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    onBlur={handleFinishAnalysisRename}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleFinishAnalysisRename()
                                      if (e.key === 'Escape') setRenamingAnalysisId(null)
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                ) : (
                                  <>
                                    <span className="truncate">{analysis.name}</span>
                                    <LanguageBadge language={analysis.config.language as AnalysisLanguage | undefined} type={analysis.type} />
                                  </>
                                )}
                              </button>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem onClick={() => handleStartAnalysisRename(analysis.id, analysis.name)}>
                                <Pencil size={14} />
                                {t('datasets.rename')}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                variant="destructive"
                                onClick={() => deleteAnalysis(analysis.id)}
                              >
                                <Trash2 size={14} />
                                {t('datasets.delete')}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        )
                      })}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </Allotment.Pane>

          {/* Right side: toolbar + tabs + content (data table | analyses | stats) */}
          <Allotment.Pane minSize={200}>
            <div className="flex h-full flex-col">
              {/* Toolbar */}
              <div className="flex items-center gap-1 border-b px-3 py-1.5">
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
                      variant={dataTableVisible ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      onClick={() => setDataTableVisible(!dataTableVisible)}
                      disabled={!selectedFileId}
                    >
                      {dataTableVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('datasets.toggle_data_table')}</TooltipContent>
                </Tooltip>

                <div className="ml-auto flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={statsVisible ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={() => setStatsVisible(!statsVisible)}
                        disabled={!selectedFileId}
                      >
                        <PanelRight size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('datasets.toggle_stats')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {/* File tabs + analysis tabs */}
              {openFileIds.length > 0 && (
                <div className="flex items-center border-b bg-muted/30">
                  <div className="flex items-center overflow-x-auto">
                    {openFileIds.map((fid) => {
                      const node = files.find((n) => n.id === fid)
                      if (!node) return null
                      const isActive = fid === selectedFileId && !selectedAnalysisId
                      const isDirty = _dirtyVersion >= 0 && isFileDirty(fid)
                      return (
                        <ContextMenu key={fid}>
                          <ContextMenuTrigger asChild>
                            <button
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('dataset-tab-id', fid)
                                e.dataTransfer.effectAllowed = 'move'
                                setDragFileId(fid)
                              }}
                              onDragOver={(e) => {
                                if (!e.dataTransfer.types.includes('dataset-tab-id')) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                setDropFileTarget(fid)
                              }}
                              onDragLeave={() => setDropFileTarget(null)}
                              onDrop={(e) => {
                                e.preventDefault()
                                setDropFileTarget(null)
                                setDragFileId(null)
                                const draggedId = e.dataTransfer.getData('dataset-tab-id')
                                if (!draggedId || draggedId === fid) return
                                const fromIdx = openFileIds.indexOf(draggedId)
                                const toIdx = openFileIds.indexOf(fid)
                                if (fromIdx !== -1 && toIdx !== -1) reorderOpenFiles(fromIdx, toIdx)
                              }}
                              onDragEnd={() => {
                                setDragFileId(null)
                                setDropFileTarget(null)
                              }}
                              onClick={() => {
                                selectFile(fid)
                                selectAnalysis(null)
                                setDataTableVisible(true)
                              }}
                              className={cn(
                                'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                isActive
                                  ? 'bg-background text-foreground'
                                  : 'text-muted-foreground hover:bg-accent/50',
                                dragFileId === fid && 'opacity-40',
                                dropFileTarget === fid && dragFileId !== fid && 'ring-1 ring-inset ring-primary/50'
                              )}
                            >
                              <span className="max-w-[140px] truncate">{node.name}</span>
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

                    {/* Analysis tabs for the selected file */}
                    {selectedFileId && openAnalysisIds.length > 0 && (
                      <>
                        <div className="mx-1 h-4 w-px shrink-0 bg-border" />
                        {openAnalysisIds.map((aid) => {
                          const analysis = analyses.find((a) => a.id === aid)
                          if (!analysis) return null
                          const isActive = analysis.id === selectedAnalysisId
                          return (
                            <ContextMenu key={analysis.id}>
                              <ContextMenuTrigger asChild>
                                <button
                                  onClick={() => {
                                    if (isActive) {
                                      selectAnalysis(null)
                                      setDataTableVisible(true)
                                    } else {
                                      selectAnalysis(analysis.id)
                                      setDataTableVisible(false)
                                      setStatsVisible(false)
                                    }
                                  }}
                                  className={cn(
                                    'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                                    isActive
                                      ? 'bg-background text-foreground'
                                      : 'text-muted-foreground hover:bg-accent/50',
                                  )}
                                >
                                  <BarChart3 size={12} className="shrink-0 text-violet-500" />
                                  <span className="max-w-[140px] truncate">{analysis.name}</span>
                                  <LanguageBadge language={analysis.config.language as AnalysisLanguage | undefined} type={analysis.type} />
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleCloseAnalysis(analysis.id)
                                    }}
                                    className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                                  >
                                    <X size={10} />
                                  </span>
                                </button>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onClick={() => handleCloseAnalysis(analysis.id)}>
                                  {t('files.close')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleCloseOtherAnalyses(analysis.id)}>
                                  {t('files.close_others')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={handleCloseAllAnalyses}>
                                  {t('files.close_all')}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          )
                        })}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Content area: data table or analysis | stats */}
              <div className="min-h-0 flex-1 overflow-hidden">
                {selectedFile ? (
                  <Allotment proportionalLayout={false}>
                    {/* Main content: data table or analysis */}
                    <Allotment.Pane minSize={200}>
                      {selectedAnalysisId ? (
                        <AnalysesPanel
                          datasetFileId={selectedFileId!}
                          hideTabBar
                        />
                      ) : (
                        dataTableVisible ? (
                          <DatasetTable
                            fileId={selectedFileId!}
                            selectedColumnId={selectedColumnId}
                            onSelectColumn={(colId) => {
                              setSelectedColumnId(colId)
                              if (colId) setStatsVisible(true)
                            }}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                            {t('datasets.data_table_hidden')}
                          </div>
                        )
                      )}
                    </Allotment.Pane>

                    {/* Right: column stats */}
                    <Allotment.Pane
                      preferredSize={280}
                      minSize={200}
                      maxSize={400}
                      visible={statsVisible}
                    >
                      <div className="flex h-full flex-col border-l">
                        <ColumnStatsPanel
                          fileId={selectedFileId}
                          columnId={selectedColumnId}
                        />
                      </div>
                    </Allotment.Pane>
                  </Allotment>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    <Table2
                      size={32}
                      className="text-muted-foreground/50"
                    />
                    <p className="mt-3 text-sm font-medium text-foreground">
                      {t('datasets.no_file_selected')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('datasets.select_or_create')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {/* Dialogs */}
      <CreateDatasetDialog
        open={createDatasetOpen}
        onOpenChange={setCreateDatasetOpen}
        parentId={selectedParentId}
      />
      <CreateFolderDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        parentId={selectedParentId}
      />
      <UploadDatasetDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        parentId={selectedParentId}
      />
      {selectedFileId && (
        <CreateAnalysisDialog
          open={createAnalysisOpen}
          onOpenChange={setCreateAnalysisOpen}
          datasetFileId={selectedFileId}
        />
      )}

      {/* Unsaved changes confirmation dialog */}
      <Dialog
        open={!!closeConfirmFileId}
        onOpenChange={(open) => {
          if (!open) setCloseConfirmFileId(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.unsaved_changes_title')}</DialogTitle>
            <DialogDescription>
              {t('files.unsaved_changes_description', {
                name: files.find((n) => n.id === closeConfirmFileId)?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="outline"
              onClick={() => setCloseConfirmFileId(null)}
            >
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
    </TooltipProvider>
  )
}
