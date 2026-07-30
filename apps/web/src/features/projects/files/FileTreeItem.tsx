import { useTranslation } from 'react-i18next'
import { useState, useRef, useEffect } from 'react'
import { useFileStore } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { useDatasetStore } from '@/stores/dataset-store'
import { isDataExtension } from '@/lib/entity-io'
import type { TreeNode, DatasetBridgeNode } from '@/hooks/use-project-tree'
import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  GitCommitVertical,
  Pencil,
  Trash2,
  Download,
  Copy,
  FilePlus,
  FolderPlus,
  Clipboard,
  Lock,
  Notebook,
  Check,
  X,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FileTreeItemProps {
  node: TreeNode
  depth: number
  getChildren: (parentId: string) => TreeNode[]
  expandedFolders: string[]
  selectedFileId: string | null
  /** Open a create dialog targeting a folder (null = scripts root). */
  onNewChild: (parentId: string | null, folderMode: boolean) => void
}

function getFileIcon(name: string, type: 'file' | 'folder', isOpen: boolean, isDataset = false) {
  if (type === 'folder') {
    return isOpen ? (
      <FolderOpen size={14} className="shrink-0 text-blue-400" />
    ) : (
      <Folder size={14} className="shrink-0 text-blue-400" />
    )
  }
  // Dataset nodes get the spreadsheet icon whatever their name — the Datasets page
  // shows it unconditionally, and a dataset may be named without a .csv/.xlsx suffix.
  if (isDataset) {
    return <FileSpreadsheet size={14} className="shrink-0 text-emerald-500" />
  }
  const ext = name.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'py':
      return <FileCode size={14} className="shrink-0 text-yellow-500" />
    case 'r':
      return <FileCode size={14} className="shrink-0 text-blue-500" />
    case 'rmd':
      return <Notebook size={14} className="shrink-0 text-blue-500" />
    case 'qmd':
      return <Notebook size={14} className="shrink-0 text-violet-500" />
    case 'ipynb':
      return <Notebook size={14} className="shrink-0 text-amber-500" />
    case 'sql':
      return <FileCode size={14} className="shrink-0 text-orange-400" />
    case 'json':
      return <FileJson size={14} className="shrink-0 text-green-400" />
    case 'md':
      return <FileText size={14} className="shrink-0 text-muted-foreground" />
    case 'sh':
      return <FileCode size={14} className="shrink-0 text-green-500" />
    // Dataset files — match the Datasets page (FileSpreadsheet, emerald).
    case 'csv':
    case 'tsv':
    case 'xlsx':
    case 'xls':
    case 'parquet':
      return <FileSpreadsheet size={14} className="shrink-0 text-emerald-500" />
    default:
      return <File size={14} className="shrink-0 text-muted-foreground" />
  }
}

function getAllDescendantIds(files: TreeNode[], parentId: string): string[] {
  const children = files.filter((f) => f.parentId === parentId)
  const ids: string[] = [parentId]
  for (const child of children) {
    ids.push(...getAllDescendantIds(files, child.id))
  }
  return ids
}

// Path relative to the IDE root, matching the EXPORT tree (`buildIdePath` over the
// re-rooted tree). Front-only keeps a synthetic `scripts` container folder at the
// store root; the export drops it and reparents its children to null. So we must
// stop the walk AT that container (not include its name) — otherwise the key comes
// out `scripts/foo` here while the export writes `foo`, and a marked file's
// `!scripts/foo` .gitignore exception never matches (silent non-versioning).
function getNodePath(files: TreeNode[], nodeId: string): string {
  const parts: string[] = []
  let current = files.find((f) => f.id === nodeId)
  while (current) {
    const isSyntheticRoot =
      current.parentId == null && current.type === 'folder' && current.name === 'scripts'
    if (isSyntheticRoot) break
    parts.unshift(current.name)
    current = current.parentId
      ? files.find((f) => f.id === current!.parentId)
      : undefined
  }
  return parts.join('/')
}

export function FileTreeItem({
  node,
  depth,
  getChildren,
  expandedFolders,
  selectedFileId,
  onNewChild,
}: FileTreeItemProps) {
  const { t } = useTranslation()
  const canWrite = useMyProjectRole().can('ide:write')
  const canDelete = useMyProjectRole().can('ide:delete')
  const { files, selectFile, toggleFolder, deleteNode, duplicateFile, moveNode, openInEditorMode, renameNode } = useFileStore()
  const datasetStore = useDatasetStore()
  // Per-file versioning. Key = the export tree path `scripts/<idePath>` (same
  // namespace the Datasets sidebar uses and the .gitignore exception matches).
  // Two lists in project.config:
  //   - versionedDataFiles: data files (gitignored by default) explicitly INCLUDED
  //   - excludedFiles:      code files (versioned by default) explicitly EXCLUDED
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const toggleVersionedDataFile = useAppStore((s) => s.toggleVersionedDataFile)
  const toggleExcludedFile = useAppStore((s) => s.toggleExcludedFile)
  const versionedRaw = useAppStore((s) => {
    const cfg = s._projectsRaw.find((p) => p.uid === activeProjectUid)?.config as Record<string, unknown> | undefined
    return cfg?.versionedDataFiles
  })
  const excludedRaw = useAppStore((s) => {
    const cfg = s._projectsRaw.find((p) => p.uid === activeProjectUid)?.config as Record<string, unknown> | undefined
    return cfg?.excludedFiles
  })
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Inline rename (in the sidebar) — replaces the old modal.
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(node.name)
  const renameRef = useRef<HTMLInputElement>(null)

  // datasets/ is now a read-only virtual view, so no node is a bridge anymore;
  // these resolve false/undefined at runtime. Kept so the surrounding branches
  // (which still reference them) compile unchanged.
  const isBridge = 'datasetBridge' in node && (node as unknown as DatasetBridgeNode).datasetBridge === true
  const bridgeDatasetFileId = isBridge ? (node as unknown as DatasetBridgeNode).datasetFileId : undefined
  const isVirtual = node.virtual === true
  const isFolder = node.type === 'folder'
  const isExpanded = expandedFolders.includes(node.id)
  const isSelected = selectedFileId === node.id
  const children = isFolder ? getChildren(node.id) : []

  // Every real file has a versioning state. A data file is gitignored by default
  // (included only if marked); a code file is versioned by default (excluded only
  // if marked). The key is its export tree path `scripts/<idePath>`.
  const isRealFile = !isFolder && !isVirtual
  const isDataFile = isRealFile && isDataExtension(node.name)
  const markKey = isRealFile ? `scripts/${getNodePath(files as TreeNode[], node.id)}` : ''
  const includedSet = new Set(
    Array.isArray(versionedRaw) ? (versionedRaw as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  )
  const excludedSet = new Set(
    Array.isArray(excludedRaw) ? (excludedRaw as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  )
  // Will this file be versioned? data → only if included; code → unless excluded.
  const willBeVersioned = isDataFile ? includedSet.has(markKey) : isRealFile && !excludedSet.has(markKey)
  const toggleVersioning = () => {
    if (!activeProjectUid) return
    if (isDataFile) void toggleVersionedDataFile(activeProjectUid, markKey)
    else void toggleExcludedFile(activeProjectUid, markKey)
  }

  const handleClick = () => {
    if (isFolder) {
      toggleFolder(node.id)
    } else {
      selectFile(node.id)
    }
  }

  const startRename = () => {
    setRenameValue(node.name)
    setRenaming(true)
  }

  const trimmedRename = renameValue.trim()
  // Reject a name already used by a sibling (same parent), case-insensitive.
  const renameClashes =
    !!trimmedRename &&
    trimmedRename.toLowerCase() !== node.name.toLowerCase() &&
    files.some(
      (f) => f.parentId === node.parentId && f.id !== node.id && f.name.toLowerCase() === trimmedRename.toLowerCase(),
    )

  const submitRename = () => {
    if (!trimmedRename || renameClashes) return
    if (trimmedRename !== node.name) {
      if (isBridge && bridgeDatasetFileId) datasetStore.renameNode(bridgeDatasetFileId, trimmedRename)
      else renameNode(node.id, trimmedRename)
    }
    setRenaming(false)
  }

  useEffect(() => {
    if (!renaming) return
    // The context menu closes and restores focus a frame or two later; poll a few
    // frames so we focus + select once focus settles on the input.
    let tries = 0
    let raf = 0
    const tick = () => {
      const el = renameRef.current
      if (el) {
        if (document.activeElement !== el) el.focus()
        if (document.activeElement === el) {
          // Base name (before extension) for files, all for folders.
          const dot = node.name.lastIndexOf('.')
          if (!isFolder && dot > 0) el.setSelectionRange(0, dot)
          else el.select()
          return
        }
      }
      if (tries++ < 10) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [renaming, node.name, isFolder])

  const handleDragStart = (e: React.DragEvent) => {
    if (isVirtual && !isBridge) { e.preventDefault(); return }
    e.dataTransfer.setData('text/plain', node.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFolder || (isVirtual && !isBridge)) return
    // Only accept file-tree drags, not tab reorder drags
    if (e.dataTransfer.types.includes('file-tab-id') || e.dataTransfer.types.includes('output-tab-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!isFolder || (isVirtual && !isBridge)) return
    const draggedId = e.dataTransfer.getData('text/plain')
    if (!draggedId || draggedId === node.id) return
    // Prevent dropping a folder into itself or its descendants
    const descendants = getAllDescendantIds(files, draggedId)
    if (descendants.includes(node.id)) return
    // Bridge nodes delegate move to dataset-store
    if (isBridge && draggedId.startsWith('ds-bridge:')) {
      const draggedDsId = draggedId.replace('ds-bridge:', '')
      datasetStore.moveNode(draggedDsId, bridgeDatasetFileId!)
      if (!expandedFolders.includes(node.id)) toggleFolder(node.id)
      return
    }
    moveNode(draggedId, node.id)
    if (!expandedFolders.includes(node.id)) {
      toggleFolder(node.id)
    }
  }

  const handleDownload = () => {
    if (node.type !== 'file') return
    const content = node.content ?? ''
    if (!content) return
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = node.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDelete = () => {
    if (isBridge && bridgeDatasetFileId) {
      datasetStore.deleteNode(bridgeDatasetFileId)
    } else {
      deleteNode(node.id)
    }
    setDeleteConfirmOpen(false)
  }

  const rowIcon = (
    <>
      {isFolder && (
        <span className="shrink-0">
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      )}
      {!isFolder && <span className="w-3 shrink-0" />}
      {getFileIcon(node.name, node.type, isExpanded, node.id.startsWith('virtual:datasets/node/'))}
    </>
  )

  // Editing renders a plain row (no <button>/ContextMenuTrigger): an <input>
  // nested in a <button> is invalid HTML and made the button steal focus/keys
  // (selection cleared, Escape leaked to the page). A div keeps the input local.
  if (renaming) {
    return (
      <>
        <div
          className="flex h-6 w-full min-w-0 items-center gap-1 px-2 text-xs"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {rowIcon}
          <span className={cn(
            '-ml-0.5 flex h-5 min-w-0 flex-1 items-center gap-0.5 rounded border bg-background pr-0.5',
            renameClashes ? 'border-destructive' : 'border-primary',
          )}>
            <input
              ref={renameRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              title={renameClashes ? t('files.name_exists', { name: trimmedRename }) : undefined}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') submitRename()
                else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) }
              }}
              className="w-0 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('common.cancel')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setRenaming(false)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <X size={11} />
            </button>
            <button
              type="button"
              tabIndex={-1}
              disabled={renameClashes || !trimmedRename}
              aria-label={t('common.save')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={submitRename}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-green-600 disabled:pointer-events-none disabled:opacity-40"
            >
              <Check size={11} />
            </button>
          </span>
        </div>
        {isFolder && isExpanded && children.map((child) => (
          <FileTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            getChildren={getChildren}
            expandedFolders={expandedFolders}
            selectedFileId={selectedFileId}
            onNewChild={onNewChild}
          />
        ))}
      </>
    )
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={handleClick}
            draggable={!isVirtual || isBridge}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              'flex h-6 w-full items-center gap-1 px-2 text-left text-xs hover:bg-accent/50 transition-colors',
              isSelected && !isFolder && 'bg-accent text-accent-foreground',
              dragOver && 'bg-accent/70 ring-1 ring-primary/50'
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {rowIcon}
            <span className="truncate">{node.name}</span>
            {isRealFile && willBeVersioned && (
              <GitCommitVertical size={11} className="shrink-0 text-primary" aria-label={t('datasets.versioned_badge')} />
            )}
            {isVirtual && !isBridge && !isFolder && (
              <Lock size={10} className="ml-auto shrink-0 text-muted-foreground/50" />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isVirtual && !isBridge ? (
            <>
              <ContextMenuItem
                onClick={() => {
                  const path = getNodePath(files as TreeNode[], node.id)
                  navigator.clipboard.writeText(path)
                }}
              >
                <Clipboard size={14} />
                {t('files.copy_relative_path')}
              </ContextMenuItem>
              {/* datasets/ files (showInIde) omit Download — it lives on the
                  Datasets page; the IDE only mirrors them read-only. */}
              {!isFolder && (node as { showInIde?: true }).showInIde !== true && (
                <ContextMenuItem onClick={handleDownload}>
                  <Download size={14} />
                  {t('files.download')}
                </ContextMenuItem>
              )}
            </>
          ) : (
            <>
              {isFolder && (
                <>
                  <ContextMenuItem disabled={!canWrite} onClick={() => onNewChild(node.id, false)}>
                    <FilePlus size={14} />
                    {t('files.new_file')}
                  </ContextMenuItem>
                  <ContextMenuItem disabled={!canWrite} onClick={() => onNewChild(node.id, true)}>
                    <FolderPlus size={14} />
                    {t('files.new_folder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={startRename} disabled={!canWrite}>
                <Pencil size={14} />
                {t('files.rename')}
              </ContextMenuItem>
              {!isFolder && /\.(csv|tsv)$/i.test(node.name) && (
                <ContextMenuItem onClick={() => openInEditorMode(node.id)}>
                  <FileCode size={14} />
                  {t('files.edit_in_editor')}
                </ContextMenuItem>
              )}
              {!isFolder && (
                <ContextMenuItem disabled={!canWrite} onClick={() => {
                  if (isBridge && bridgeDatasetFileId) {
                    datasetStore.duplicateFile(bridgeDatasetFileId)
                  } else {
                    duplicateFile(node.id)
                  }
                }}>
                  <Copy size={14} />
                  {t('files.duplicate')}
                </ContextMenuItem>
              )}
              {!isFolder && (
                <ContextMenuItem onClick={handleDownload}>
                  <Download size={14} />
                  {t('files.download')}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => {
                  const path = getNodePath(files as TreeNode[], node.id)
                  navigator.clipboard.writeText(`/project/files/${path}`)
                }}
              >
                <Clipboard size={14} />
                {t('files.copy_path')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  const path = getNodePath(files as TreeNode[], node.id)
                  navigator.clipboard.writeText(path)
                }}
              >
                <Clipboard size={14} />
                {t('files.copy_relative_path')}
              </ContextMenuItem>
              {isRealFile && activeProjectUid && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={toggleVersioning}>
                    <GitCommitVertical size={14} />
                    {willBeVersioned ? t('datasets.unmark_versioned') : t('datasets.mark_versioned')}
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={!canDelete}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 size={14} />
                {t('files.delete')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {isFolder &&
        isExpanded &&
        children.map((child) => (
          <FileTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            getChildren={getChildren}
            expandedFolders={expandedFolders}
            selectedFileId={selectedFileId}
            onNewChild={onNewChild}
          />
        ))}

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('files.delete_confirm_title')}</DialogTitle>
            <DialogDescription>
              {isFolder
                ? t('files.delete_confirm_folder', { name: node.name })
                : t('files.delete_confirm_file', { name: node.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t('files.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
