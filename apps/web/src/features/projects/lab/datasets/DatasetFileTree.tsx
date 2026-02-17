import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Folder,
  FolderOpen,
  FileSpreadsheet,
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
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { ImportSettingsDialog } from './ImportSettingsDialog'
import type { DatasetFile } from '@/types'

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
  const [editName, setEditName] = useState(node.name)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isFolder = node.type === 'folder'
  const isExpanded = expandedFolders.includes(node.id)
  const isSelected = selectedFileId === node.id
  const children = isFolder ? getChildren(node.id) : []

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const handleClick = () => {
    if (isFolder) {
      toggleFolder(node.id)
    } else {
      selectFile(node.id)
      openFile(node.id)
    }
  }

  const handleRenameSubmit = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== node.name) {
      renameNode(node.id, trimmed)
    }
    setEditing(false)
  }

  const handleStartRename = () => {
    setEditName(node.name)
    setEditing(true)
  }

  const handleDuplicate = () => {
    const baseName = node.name.replace(/\.[^.]+$/, '')
    const ext = node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.')) : ''
    const copyName = `${baseName} (copy)${ext}`
    const store = useDatasetStore.getState()
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

  const handleDownload = () => {
    if (node.type !== 'file') return
    const rows = useDatasetStore.getState().getFileRows(node.id)
    const columns = node.columns ?? []
    if (columns.length === 0) return
    // Build CSV
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
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = node.name
    a.click()
    URL.revokeObjectURL(url)
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
              <input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit()
                  if (e.key === 'Escape') setEditing(false)
                }}
                className="ml-1 flex-1 bg-transparent text-xs outline-none border-b border-primary"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="ml-1 truncate">{node.name}</span>
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
          <ContextMenuItem
            onClick={() => {
              const path = getNodePath(files, node.id)
              navigator.clipboard.writeText(path)
            }}
          >
            <Clipboard size={14} />
            {t('files.copy_relative_path')}
          </ContextMenuItem>
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

  if (rootNodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">{t('datasets.no_files')}</p>
      </div>
    )
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
    <>
      <ScrollArea className="flex-1">
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
            <AlertDialogAction onClick={handleConfirmDelete}>
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
    </>
  )
}
