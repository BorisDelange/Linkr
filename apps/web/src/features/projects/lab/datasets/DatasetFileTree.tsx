import { createContext, useContext, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Folder,
  FolderOpen,
  FileSpreadsheet,
  GitCommitVertical,
  Pencil,
  Trash2,
  Copy,
  Download,
  Clipboard,
  ChevronRight,
  ChevronDown,
  Settings2,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FolderPathBar } from '@/features/projects/files/FolderPathBar'
import { InlineRenameField } from '@/components/InlineRenameField'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { useAppStore } from '@/stores/app-store'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { queryDatasetRows } from '@/lib/api/datasets'
import { useResolvedDirs } from '@/hooks/use-resolved-dirs'
import { ImportSettingsDialog } from './ImportSettingsDialog'
import type { DatasetFile } from '@/types'

/** Resolved server dirs (server mode) shared with every tree item so the context
 * menu can build an absolute "Copy path" and decide whether a relative path is
 * meaningful (only when the datasets dir sits under the IDE working dir). */
const ResolvedDirsContext = createContext<{ ideDir: string; datasetsDir: string } | null>(null)

/** Per-project versioning marks shared with every tree item: which dataset paths
 * are marked "to version" (badge + default menu state) and how to toggle one. */
const VersioningContext = createContext<{
  marked: Set<string>
  toggle: (path: string) => void
} | null>(null)

function sortNodes(a: DatasetFile, b: DatasetFile): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function getAllDescendantIds(files: DatasetFile[], parentId: string): string[] {
  const children = files.filter((f) => f.parentId === parentId)
  const ids: string[] = [parentId]
  for (const child of children) {
    ids.push(...getAllDescendantIds(files, child.id))
  }
  return ids
}

function getNodePath(files: DatasetFile[], nodeId: string): string {
  const parts: string[] = []
  let current = files.find((f) => f.id === nodeId)
  while (current) {
    parts.unshift(current.name)
    current = current.parentId
      ? files.find((f) => f.id === current!.parentId)
      : undefined
  }
  return parts.join('/')
}

// ---------------------------------------------------------------------------
// DatasetTreeItem
// ---------------------------------------------------------------------------

interface DatasetTreeItemProps {
  node: DatasetFile
  depth: number
  getChildren: (parentId: string) => DatasetFile[]
  onRequestDelete: (node: DatasetFile) => void
  onRequestImportSettings: (node: DatasetFile) => void
}

function DatasetTreeItem({ node, depth, getChildren, onRequestDelete, onRequestImportSettings }: DatasetTreeItemProps) {
  const { t } = useTranslation()
  const {
    files,
    selectedFileId,
    expandedFolders,
    toggleFolder,
    selectFile,
    openFile,
    renameNode,
    moveNode,
  } = useDatasetStore()

  const [editing, setEditing] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const resolvedDirs = useContext(ResolvedDirsContext)
  // A relative path only resolves from a script when datasets sits under the IDE
  // working dir; otherwise the absolute path is the only usable one.
  const relativeMeaningful =
    !resolvedDirs ||
    resolvedDirs.datasetsDir === resolvedDirs.ideDir ||
    resolvedDirs.datasetsDir.startsWith(`${resolvedDirs.ideDir}/`)

  const versioning = useContext(VersioningContext)
  const nodeDsPath = getNodePath(files, node.id)
  // Marking key is the logical export path `datasets/<dsPath>` (a single namespace
  // shared with the IDE sidebar's scripts/<path>). Data files are gitignored by
  // default; a marked one is versioned (committed + exported).
  const markKey = `datasets/${nodeDsPath}`
  const isMarkedVersioned = versioning?.marked.has(markKey) ?? false

  const isFolder = node.type === 'folder'
  const isExpanded = expandedFolders.includes(node.id)
  const isSelected = selectedFileId === node.id
  const children = isFolder ? getChildren(node.id) : []

  const handleClick = () => {
    if (isFolder) {
      toggleFolder(node.id)
    } else {
      selectFile(node.id)
      openFile(node.id)
    }
  }

  const handleStartRename = () => {
    setEditing(true)
  }

  const handleDuplicate = () => {
    const store = useDatasetStore.getState()
    // Server mode: rows live in a Parquet blob — duplicate server-side (the store
    // re-points the content-addressed blobs) instead of copying rows in memory.
    if (isServerMode()) {
      store.duplicateFile(node.id)
      return
    }
    const baseName = node.name.replace(/\.[^.]+$/, '')
    const ext = node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.')) : ''
    const copyName = `${baseName} (copy)${ext}`
    store.createFile(copyName, node.parentId)
    // Copy columns + data from the original file
    const newState = useDatasetStore.getState()
    const newFile = newState.files[newState.files.length - 1]
    if (newFile && node.type === 'file') {
      const rows = store.getFileRows(node.id)
      const columns = node.columns ?? []
      if (columns.length > 0) {
        store.importData(newFile.id, columns, rows.map((r) => ({ ...r })))
      }
    }
  }

  const handleDownload = async () => {
    if (node.type !== 'file') return

    // Prefer the original uploaded file (XLSX/parquet/CSV) so the download keeps the real
    // bytes and extension. Only fall back to a reconstructed CSV when there's no source file.
    const raw = await getStorage().datasetRawFiles.get(node.id)
    const trigger = (blob: Blob, fileName: string) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    }

    if (raw?.blob) {
      trigger(raw.blob, raw.fileName || node.name)
      return
    }

    // No raw file (e.g. a manually-created dataset): reconstruct a CSV. In server
    // mode the rows aren't in memory (datasetData.get no-ops on the API adapter),
    // so page them from the server; front-only reads the in-memory/IDB rows.
    const columns = node.columns ?? []
    if (columns.length === 0) return
    let rows = useDatasetStore.getState().getFileRows(node.id)
    if (rows.length === 0) {
      if (isServerMode()) {
        const total = node.rowCount ?? 0
        if (total > 0) {
          const page = await queryDatasetRows(node.id, { offset: 0, limit: total })
          rows = page.rows
        }
      } else {
        const data = await getStorage().datasetData.get(node.id)
        rows = data?.rows ?? []
      }
    }
    const header = columns.map((c) => c.name).join(',')
    const lines = rows.map((row) =>
      columns.map((c) => {
        const v = row[c.id]
        if (v == null) return ''
        const s = String(v)
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"`
          : s
      }).join(',')
    )
    const csv = [header, ...lines].join('\n')
    // Reconstructed content is CSV — force a .csv name even if the dataset is named *.xlsx.
    const csvName = node.name.replace(/\.[^.]+$/, '') + '.csv'
    trigger(new Blob([csv], { type: 'text/csv' }), csvName)
  }

  // --- Drag & drop ---

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFolder) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (!isFolder) return
    const draggedId = e.dataTransfer.getData('text/plain')
    if (!draggedId || draggedId === node.id) return
    const descendants = getAllDescendantIds(files, draggedId)
    if (descendants.includes(node.id)) return
    moveNode(draggedId, node.id)
    if (!expandedFolders.includes(node.id)) {
      toggleFolder(node.id)
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group flex items-center gap-0.5 px-1 py-0.5 cursor-pointer text-xs hover:bg-accent/50 transition-colors',
              isSelected && !isFolder && 'bg-accent text-accent-foreground',
              dragOver && 'bg-accent/70 ring-1 ring-primary/50',
            )}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
            onClick={handleClick}
            draggable={!editing}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Chevron for folders */}
            {isFolder ? (
              isExpanded ? (
                <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="w-3.5 shrink-0" />
            )}

            {/* Icon */}
            {isFolder ? (
              isExpanded ? (
                <FolderOpen size={14} className="shrink-0 text-blue-400" />
              ) : (
                <Folder size={14} className="shrink-0 text-blue-400" />
              )
            ) : (
              <FileSpreadsheet size={14} className="shrink-0 text-emerald-500" />
            )}

            {/* Name or inline rename input */}
            {editing ? (
              <InlineRenameField
                initialValue={node.name}
                selectBaseName={!isFolder}
                onSubmit={(name) => { renameNode(node.id, name); setEditing(false) }}
                onCancel={() => setEditing(false)}
                hasClash={(candidate) =>
                  files.some((f) => f.parentId === node.parentId && f.id !== node.id && f.name.toLowerCase() === candidate.toLowerCase())
                }
                className="ml-1"
              />
            ) : (
              <span className="ml-1 flex min-w-0 items-center gap-1 truncate">
                <span className="truncate">{node.name}</span>
                {isMarkedVersioned && (
                  <GitCommitVertical
                    size={12}
                    className="shrink-0 text-primary"
                    aria-label={t('datasets.versioned_badge')}
                  >
                    <title>{t('datasets.versioned_badge')}</title>
                  </GitCommitVertical>
                )}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleStartRename}>
            <Pencil size={14} />
            {t('datasets.rename')}
          </ContextMenuItem>
          {!isFolder && (
            <ContextMenuItem onClick={handleDuplicate}>
              <Copy size={14} />
              {t('datasets.duplicate')}
            </ContextMenuItem>
          )}
          {!isFolder && (
            <ContextMenuItem onClick={handleDownload}>
              <Download size={14} />
              {t('files.download')}
            </ContextMenuItem>
          )}
          {!isFolder && (
            <ContextMenuItem onClick={() => onRequestImportSettings(node)}>
              <Settings2 size={14} />
              {t('datasets.import_settings')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {!isFolder && versioning && (
            <ContextMenuItem onClick={() => versioning.toggle(markKey)}>
              <GitCommitVertical size={14} />
              {isMarkedVersioned ? t('datasets.unmark_versioned') : t('datasets.mark_versioned')}
            </ContextMenuItem>
          )}
          {resolvedDirs && (
            <ContextMenuItem
              onClick={() => {
                navigator.clipboard.writeText(`${resolvedDirs.datasetsDir}/${nodeDsPath}`)
              }}
            >
              <Clipboard size={14} />
              {t('files.copy_path')}
            </ContextMenuItem>
          )}
          {relativeMeaningful ? (
            <ContextMenuItem
              onClick={() => {
                const path = getNodePath(files, node.id)
                navigator.clipboard.writeText(path)
              }}
            >
              <Clipboard size={14} />
              {t('files.copy_relative_path')}
            </ContextMenuItem>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled menu item swallows pointer events, so wrap it to keep
                    the tooltip reachable on hover. */}
                <div>
                  <ContextMenuItem disabled onSelect={(e) => e.preventDefault()}>
                    <Clipboard size={14} />
                    {t('files.copy_relative_path')}
                  </ContextMenuItem>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                {t('files.copy_relative_path_disabled')}
              </TooltipContent>
            </Tooltip>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => onRequestDelete(node)}
          >
            <Trash2 size={14} />
            {t('datasets.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Children */}
      {isFolder &&
        isExpanded &&
        children.map((child) => (
          <DatasetTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            getChildren={getChildren}
            onRequestDelete={onRequestDelete}
            onRequestImportSettings={onRequestImportSettings}
          />
        ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// DatasetFileTree
// ---------------------------------------------------------------------------

export function DatasetFileTree() {
  const { t } = useTranslation()
  const { files, moveNode, deleteNode } = useDatasetStore()
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const idePath = useAppStore((s) => s._projectsRaw.find((p) => p.uid === activeProjectUid)?.idePath)
  const datasetsPath = useAppStore((s) => s._projectsRaw.find((p) => p.uid === activeProjectUid)?.datasetsPath)
  const toggleVersionedDataFile = useAppStore((s) => s.toggleVersionedDataFile)
  const versionedRaw = useAppStore((s) => {
    const cfg = s._projectsRaw.find((p) => p.uid === activeProjectUid)?.config as Record<string, unknown> | undefined
    return cfg?.versionedDataFiles
  })
  const markedPaths = useMemo(
    () => new Set(Array.isArray(versionedRaw) ? (versionedRaw as unknown[]).filter((p): p is string => typeof p === 'string') : []),
    [versionedRaw],
  )
  // Re-resolve when a binding changes (the settings tab may have re-pointed it).
  const resolved = useResolvedDirs(activeProjectUid, `${idePath ?? ''}|${datasetsPath ?? ''}`)
  const [rootDragOver, setRootDragOver] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DatasetFile | null>(null)
  const [importSettingsTarget, setImportSettingsTarget] = useState<DatasetFile | null>(null)

  const rootNodes = files.filter((f) => f.parentId === null).sort(sortNodes)

  function getChildren(parentId: string): DatasetFile[] {
    return files.filter((f) => f.parentId === parentId).sort(sortNodes)
  }

  const handleConfirmDelete = () => {
    if (deleteTarget) {
      deleteNode(deleteTarget.id)
      setDeleteTarget(null)
    }
  }

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setRootDragOver(true)
  }

  const handleRootDragLeave = () => {
    setRootDragOver(false)
  }

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setRootDragOver(false)
    const draggedId = e.dataTransfer.getData('text/plain')
    if (!draggedId) return
    const node = files.find((f) => f.id === draggedId)
    if (!node || node.parentId === null) return
    moveNode(draggedId, null)
  }

  return (
    <ResolvedDirsContext.Provider
      value={resolved ? { ideDir: resolved.ide, datasetsDir: resolved.datasets } : null}
    >
     <VersioningContext.Provider
      value={activeProjectUid ? { marked: markedPaths, toggle: (p) => void toggleVersionedDataFile(activeProjectUid, p) } : null}
     >
      <div className="flex h-full min-h-0 flex-col">
      {resolved && <FolderPathBar path={resolved.datasets} />}
      {rootNodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">{t('datasets.no_files')}</p>
        </div>
      ) : (
      <ScrollArea className="h-full min-h-0 flex-1">
        <div
          className={cn('min-h-full py-1', rootDragOver && 'bg-accent/30')}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          {rootNodes.map((node) => (
            <DatasetTreeItem
              key={node.id}
              node={node}
              depth={0}
              getChildren={getChildren}
              onRequestDelete={setDeleteTarget}
              onRequestImportSettings={setImportSettingsTarget}
            />
          ))}
        </div>
      </ScrollArea>
      )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('datasets.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'folder'
                ? t('datasets.delete_confirm_folder', { name: deleteTarget?.name ?? '' })
                : t('datasets.delete_confirm_file', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleConfirmDelete}>
              {t('datasets.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {importSettingsTarget && (
        <ImportSettingsDialog
          open={!!importSettingsTarget}
          onOpenChange={(open) => { if (!open) setImportSettingsTarget(null) }}
          file={importSettingsTarget}
        />
      )}
     </VersioningContext.Provider>
    </ResolvedDirsContext.Provider>
  )
}
