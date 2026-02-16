import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Folder,
  FolderOpen,
  FileSpreadsheet,
  MoreHorizontal,
  Pencil,
  Trash2,
  Copy,
  ChevronRight,
  ChevronDown,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
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

// ---------------------------------------------------------------------------
// DatasetTreeItem
// ---------------------------------------------------------------------------

interface DatasetTreeItemProps {
  node: DatasetFile
  depth: number
  getChildren: (parentId: string) => DatasetFile[]
}

function DatasetTreeItem({ node, depth, getChildren }: DatasetTreeItemProps) {
  const { t } = useTranslation()
  const {
    files,
    selectedFileId,
    expandedFolders,
    toggleFolder,
    selectFile,
    openFile,
    deleteNode,
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
    // Create a copy of the file with "(copy)" suffix
    const baseName = node.name.replace(/\.[^.]+$/, '')
    const ext = node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.')) : ''
    const copyName = `${baseName} (copy)${ext}`
    const { createFile } = useDatasetStore.getState()
    createFile(copyName, node.parentId)
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
    // Prevent dropping a folder into itself or its descendants
    const descendants = getAllDescendantIds(files, draggedId)
    if (descendants.includes(node.id)) return
    moveNode(draggedId, node.id)
    if (!expandedFolders.includes(node.id)) {
      toggleFolder(node.id)
    }
  }

  return (
    <>
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

        {/* Context menu trigger (three-dot button) */}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="ml-auto shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-muted"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              <DropdownMenuItem onClick={handleStartRename}>
                <Pencil size={14} className="mr-2" />
                {t('datasets.rename')}
              </DropdownMenuItem>
              {!isFolder && (
                <DropdownMenuItem onClick={handleDuplicate}>
                  <Copy size={14} className="mr-2" />
                  {t('datasets.duplicate')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => deleteNode(node.id)}
              >
                <Trash2 size={14} className="mr-2" />
                {t('datasets.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Children */}
      {isFolder &&
        isExpanded &&
        children.map((child) => (
          <DatasetTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            getChildren={getChildren}
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
  const { files, moveNode } = useDatasetStore()
  const [rootDragOver, setRootDragOver] = useState(false)

  const rootNodes = files.filter((f) => f.parentId === null).sort(sortNodes)

  function getChildren(parentId: string): DatasetFile[] {
    return files.filter((f) => f.parentId === parentId).sort(sortNodes)
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
          />
        ))}
      </div>
    </ScrollArea>
  )
}
