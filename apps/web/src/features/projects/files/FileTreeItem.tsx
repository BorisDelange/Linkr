import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useFileStore } from '@/stores/file-store'
import { useDatasetStore } from '@/stores/dataset-store'
import type { TreeNode, DatasetBridgeNode } from '@/hooks/use-project-tree'
import {
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Pencil,
  Trash2,
  Download,
  Copy,
  FolderInput,
  Clipboard,
  Lock,
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
import { RenameDialog } from './RenameDialog'

interface FileTreeItemProps {
  node: TreeNode
  depth: number
  getChildren: (parentId: string) => TreeNode[]
  expandedFolders: string[]
  selectedFileId: string | null
}

function getFileIcon(name: string, type: 'file' | 'folder', isOpen: boolean) {
  if (type === 'folder') {
    return isOpen ? (
      <FolderOpen size={14} className="shrink-0 text-blue-400" />
    ) : (
      <Folder size={14} className="shrink-0 text-blue-400" />
    )
  }
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'py':
      return <FileCode size={14} className="shrink-0 text-yellow-500" />
    case 'r':
    case 'rmd':
    case 'qmd':
      return <FileCode size={14} className="shrink-0 text-blue-500" />
    case 'sql':
      return <FileCode size={14} className="shrink-0 text-orange-400" />
    case 'json':
    case 'ipynb':
      return <FileJson size={14} className="shrink-0 text-green-400" />
    case 'md':
      return <FileText size={14} className="shrink-0 text-muted-foreground" />
    case 'sh':
      return <FileCode size={14} className="shrink-0 text-green-500" />
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

function getNodePath(files: TreeNode[], nodeId: string): string {
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

export function FileTreeItem({
  node,
  depth,
  getChildren,
  expandedFolders,
  selectedFileId,
}: FileTreeItemProps) {
  const { t } = useTranslation()
  const { files, selectFile, toggleFolder, deleteNode, duplicateFile, moveNode } = useFileStore()
  const datasetStore = useDatasetStore()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const isBridge = 'datasetBridge' in node && (node as DatasetBridgeNode).datasetBridge === true
  const bridgeDatasetFileId = isBridge ? (node as DatasetBridgeNode).datasetFileId : undefined
  const isVirtual = node.virtual === true
  const isFolder = node.type === 'folder'
  const isExpanded = expandedFolders.includes(node.id)
  const isSelected = selectedFileId === node.id
  const children = isFolder ? getChildren(node.id) : []

  const handleClick = () => {
    if (isFolder) {
      toggleFolder(node.id)
    } else {
      selectFile(node.id)
    }
  }

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
              'flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-accent/50 transition-colors',
              isSelected && !isFolder && 'bg-accent text-accent-foreground',
              dragOver && 'bg-accent/70 ring-1 ring-primary/50'
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {isFolder && (
              <span className="shrink-0">
                {isExpanded ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
              </span>
            )}
            {!isFolder && <span className="w-3 shrink-0" />}
            {getFileIcon(node.name, node.type, isExpanded)}
            <span className="truncate">{node.name}</span>
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
              {!isFolder && (
                <ContextMenuItem onClick={handleDownload}>
                  <Download size={14} />
                  {t('files.download')}
                </ContextMenuItem>
              )}
            </>
          ) : (
            <>
              <ContextMenuItem onClick={() => setRenameOpen(true)}>
                <Pencil size={14} />
                {t('files.rename')}
              </ContextMenuItem>
              {!isFolder && (
                <ContextMenuItem onClick={() => {
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
              {isFolder && !isBridge && (
                <ContextMenuItem disabled>
                  <FolderInput size={14} />
                  {t('files.move')}
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
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
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
          />
        ))}

      {(!isVirtual || isBridge) && (
        <RenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          nodeId={node.id}
          currentName={node.name}
          onRename={isBridge && bridgeDatasetFileId
            ? (newName: string) => datasetStore.renameNode(bridgeDatasetFileId, newName)
            : undefined
          }
        />
      )}

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
