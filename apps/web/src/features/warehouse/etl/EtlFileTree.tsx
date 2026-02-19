import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileCode,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Trash2,
  Pencil,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import type { EtlFile } from '@/types'

const LANGUAGE_COLORS: Record<string, string> = {
  sql: 'text-blue-500',
  python: 'text-yellow-500',
  r: 'text-sky-500',
}

function getFileColor(file: EtlFile): string {
  if (file.language) return LANGUAGE_COLORS[file.language] ?? 'text-muted-foreground'
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'sql') return 'text-blue-500'
  if (ext === 'py') return 'text-yellow-500'
  if (ext === 'r' || ext === 'rmd') return 'text-sky-500'
  return 'text-muted-foreground'
}

export function EtlFileTree() {
  const { t } = useTranslation()
  const { files, selectedFileId, selectFile, deleteFile, updateFile } = useEtlStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [deleteConfirmFileId, setDeleteConfirmFileId] = useState<string | null>(null)

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDeleteRequest = useCallback((id: string) => {
    setDeleteConfirmFileId(id)
  }, [])

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirmFileId) {
      deleteFile(deleteConfirmFileId)
      setDeleteConfirmFileId(null)
    }
  }, [deleteConfirmFileId, deleteFile])

  const deleteConfirmFile = deleteConfirmFileId ? files.find((f) => f.id === deleteConfirmFileId) : null

  const rootFiles = files.filter((f) => f.parentId === null)
  const getChildren = (parentId: string) =>
    files.filter((f) => f.parentId === parentId).sort((a, b) => a.order - b.order)

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <FileCode size={24} className="text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">{t('etl.no_files')}</p>
      </div>
    )
  }

  return (
    <>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {rootFiles.sort((a, b) => a.order - b.order).map((file) => (
            <EtlFileTreeItem
              key={file.id}
              file={file}
              depth={0}
              isActive={file.id === selectedFileId}
              isFolder={file.type === 'folder'}
              isExpanded={expandedFolders.has(file.id)}
              onToggleFolder={toggleFolder}
              onSelect={selectFile}
              onDelete={handleDeleteRequest}
              onRename={(id, name) => updateFile(id, { name })}
              getChildren={getChildren}
              expandedFolders={expandedFolders}
              selectedFileId={selectedFileId}
            />
          ))}
        </div>
      </ScrollArea>

      <AlertDialog open={!!deleteConfirmFileId} onOpenChange={(open) => { if (!open) setDeleteConfirmFileId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('etl.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmFile?.type === 'folder'
                ? t('etl.delete_confirm_folder', { name: deleteConfirmFile?.name ?? '' })
                : t('etl.delete_confirm_file', { name: deleteConfirmFile?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('etl.delete_file')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function EtlFileTreeItem({
  file,
  depth,
  isActive,
  isFolder,
  isExpanded,
  onToggleFolder,
  onSelect,
  onDelete,
  onRename,
  getChildren,
  expandedFolders,
  selectedFileId,
}: {
  file: EtlFile
  depth: number
  isActive: boolean
  isFolder: boolean
  isExpanded: boolean
  onToggleFolder: (id: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  getChildren: (parentId: string) => EtlFile[]
  expandedFolders: Set<string>
  selectedFileId: string | null
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      const len = inputRef.current.value.length
      inputRef.current.setSelectionRange(len, len)
    }
  }, [editing])

  const handleRenameSubmit = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== file.name) {
      onRename(file.id, trimmed)
    }
    setEditing(false)
  }

  const handleStartRename = () => {
    setEditName(file.name)
    setEditing(true)
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => {
              if (isFolder) onToggleFolder(file.id)
              else onSelect(file.id)
            }}
            className={cn(
              'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
              isActive && !isFolder && 'bg-accent text-accent-foreground',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {isFolder ? (
              <>
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {isExpanded ? (
                  <FolderOpen size={14} className="text-blue-400" />
                ) : (
                  <Folder size={14} className="text-blue-400" />
                )}
              </>
            ) : (
              <>
                <span className="w-3" />
                <FileCode size={14} className={getFileColor(file)} />
              </>
            )}
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
                className="ml-0.5 flex-1 bg-transparent text-xs outline-none border-b border-primary"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="truncate">{file.name}</span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleStartRename}>
            <Pencil size={14} />
            {t('etl.rename')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDelete(file.id)}
          >
            <Trash2 size={14} />
            {t('etl.delete_file')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isFolder && isExpanded && getChildren(file.id).map((child) => (
        <EtlFileTreeItem
          key={child.id}
          file={child}
          depth={depth + 1}
          isActive={child.id === selectedFileId}
          isFolder={child.type === 'folder'}
          isExpanded={expandedFolders.has(child.id)}
          onToggleFolder={onToggleFolder}
          onSelect={onSelect}
          onDelete={onDelete}
          onRename={onRename}
          getChildren={getChildren}
          expandedFolders={expandedFolders}
          selectedFileId={selectedFileId}
        />
      ))}
    </div>
  )
}
