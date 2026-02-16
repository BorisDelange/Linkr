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
  BarChart3,
  Table2,
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
import { useDatasetStore } from '@/stores/dataset-store'
import { useAppStore } from '@/stores/app-store'
import { DatasetFileTree } from './datasets/DatasetFileTree'
import { DatasetTable } from './datasets/DatasetTable'
import { ColumnStatsPanel } from './datasets/ColumnStatsPanel'
import { AnalysesPanel } from './datasets/AnalysesPanel'
import { CreateDatasetDialog } from './datasets/CreateDatasetDialog'
import { CreateFolderDialog } from './datasets/CreateFolderDialog'
import { UploadDatasetDialog } from './datasets/UploadDatasetDialog'

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
    _dirtyVersion,
  } = useDatasetStore()
  const { activeProjectUid } = useAppStore()

  const [createDatasetOpen, setCreateDatasetOpen] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [statsVisible, setStatsVisible] = useState(true)
  const [analysesVisible, setAnalysesVisible] = useState(true)
  const [dragFileId, setDragFileId] = useState<string | null>(null)
  const [dropFileTarget, setDropFileTarget] = useState<string | null>(null)
  const [closeConfirmFileId, setCloseConfirmFileId] = useState<string | null>(null)
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null)

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
    }
  }, [selectedFileId, loadFileData, loadAnalyses])

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
        // Only intercept if we have an undo action and focus is not inside an input
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
        <Allotment proportionalLayout={false}>
          {/* Explorer sidebar */}
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
              <DatasetFileTree />
            </div>
          </Allotment.Pane>

          {/* Data table area */}
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

                <div className="ml-auto flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={analysesVisible ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={() => setAnalysesVisible(!analysesVisible)}
                        disabled={!selectedFileId}
                      >
                        <BarChart3 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('datasets.toggle_analyses')}
                    </TooltipContent>
                  </Tooltip>

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

              {/* File tabs */}
              {openFileIds.length > 0 && (
                <div className="flex items-center border-b bg-muted/30 overflow-x-auto">
                  {openFileIds.map((fid) => {
                    const node = files.find((n) => n.id === fid)
                    if (!node) return null
                    const isActive = fid === selectedFileId
                    // _dirtyVersion subscription ensures re-render on dirty state change
                    const isDirty = _dirtyVersion >= 0 && isFileDirty(fid)
                    return (
                      <button
                        key={fid}
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
                        onClick={() => selectFile(fid)}
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
                    )
                  })}
                </div>
              )}

              {/* Data table content */}
              <div className="min-h-0 flex-1 overflow-hidden">
                {selectedFile ? (
                  <DatasetTable
                    fileId={selectedFileId!}
                    selectedColumnId={selectedColumnId}
                    onSelectColumn={setSelectedColumnId}
                  />
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

          {/* Analyses panel */}
          <Allotment.Pane
            preferredSize={400}
            minSize={200}
            visible={analysesVisible && !!selectedFileId}
          >
            <div className="flex h-full flex-col border-l">
              {selectedFileId && (
                <AnalysesPanel datasetFileId={selectedFileId} />
              )}
            </div>
          </Allotment.Pane>

          {/* Column stats panel */}
          <Allotment.Pane
            preferredSize={280}
            minSize={200}
            maxSize={400}
            visible={statsVisible && !!selectedFileId}
          >
            <div className="flex h-full flex-col border-l">
              <ColumnStatsPanel
                fileId={selectedFileId}
                columnId={selectedColumnId}
              />
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
