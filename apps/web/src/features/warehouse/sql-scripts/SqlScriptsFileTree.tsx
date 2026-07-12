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
  Check,
  X,
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
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import type { SqlScriptFile } from '@/types'

export function SqlScriptsFileTree() {
  const { t } = useTranslation()
  const { files, selectedFileId, selectFile, deleteFile, updateFile } = useSqlScriptsStore()
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
  // True if another node under the same parent already has this name (rename guard).
  const nameExists = (parentId: string | null, name: string, exceptId: string) =>
    files.some(
      (f) => f.parentId === parentId && f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase(),
    )

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <FileCode size={24} className="text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">{t('sql_scripts.no_files')}</p>
      </div>
    )
  }

  return (
    <>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {rootFiles.sort((a, b) => a.order - b.order).map((file) => (
            <SqlScriptsFileTreeItem
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
              nameExists={nameExists}
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
            <AlertDialogTitle>{t('sql_scripts.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmFile?.type === 'folder'
                ? t('sql_scripts.delete_confirm_folder', { name: deleteConfirmFile?.name ?? '' })
                : t('sql_scripts.delete_confirm_file', { name: deleteConfirmFile?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-white hover:bg-destructive/90">
              {t('sql_scripts.delete_file')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SqlScriptsFileTreeItem({
  file,
  depth,
  isActive,
  isFolder,
  isExpanded,
  onToggleFolder,
  onSelect,
  onDelete,
  onRename,
  nameExists,
  getChildren,
  expandedFolders,
  selectedFileId,
}: {
  file: SqlScriptFile
  depth: number
  isActive: boolean
  isFolder: boolean
  isExpanded: boolean
  onToggleFolder: (id: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  nameExists: (parentId: string | null, name: string, exceptId: string) => boolean
  getChildren: (parentId: string) => SqlScriptFile[]
  expandedFolders: Set<string>
  selectedFileId: string | null
}) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('sql-scripts:write')
  const canDelete = useMyWorkspaceRole().can('sql-scripts:delete')
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    // The context menu closes and restores focus a frame or two after rename
    // starts; poll a few frames so we focus + select once it settles on the input.
    let tries = 0
    let raf = 0
    const tick = () => {
      const el = inputRef.current
      if (el) {
        if (document.activeElement !== el) el.focus()
        if (document.activeElement === el) {
          // Select the base name (before the extension) for files, all for folders.
          const dot = file.name.lastIndexOf('.')
          if (!isFolder && dot > 0) el.setSelectionRange(0, dot)
          else el.select()
          return
        }
      }
      if (tries++ < 10) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [editing, isFolder, file.name])

  const trimmedNewName = editName.trim()
  const renameClashes =
    !!trimmedNewName &&
    trimmedNewName.toLowerCase() !== file.name.toLowerCase() &&
    nameExists(file.parentId, trimmedNewName, file.id)

  const handleRenameSubmit = () => {
    if (!trimmedNewName || renameClashes) return
    if (trimmedNewName !== file.name) {
      onRename(file.id, trimmedNewName)
    }
    setEditing(false)
  }

  const handleStartRename = () => {
    setEditName(file.name)
    setEditing(true)
  }

  const childItems =
    isFolder && isExpanded
      ? getChildren(file.id).map((child) => (
          <SqlScriptsFileTreeItem
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
            nameExists={nameExists}
            getChildren={getChildren}
            expandedFolders={expandedFolders}
            selectedFileId={selectedFileId}
          />
        ))
      : null

  const icon = isFolder ? (
    <>
      {isExpanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
      {isExpanded ? (
        <FolderOpen size={14} className="shrink-0 text-blue-400" />
      ) : (
        <Folder size={14} className="shrink-0 text-blue-400" />
      )}
    </>
  ) : (
    <>
      <span className="w-3 shrink-0" />
      <FileCode size={14} className="shrink-0 text-blue-500" />
    </>
  )

  // Editing renders a plain row (no <button>/ContextMenuTrigger): an <input>
  // nested in a <button> is invalid HTML and made the button steal focus/keys
  // (selection cleared, Escape leaked). A div keeps the input fully in control.
  if (editing) {
    return (
      <div>
        <div
          className="flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-xs"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {icon}
          <span className={cn(
            '-ml-1 flex min-w-0 flex-1 items-center rounded border bg-background',
            renameClashes ? 'border-destructive' : 'border-primary',
          )}>
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              title={renameClashes ? t('sql_scripts.name_exists', { name: trimmedNewName }) : undefined}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') handleRenameSubmit()
                else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
              }}
              className="w-0 min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('common.cancel')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing(false)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <X size={12} />
            </button>
            <button
              type="button"
              tabIndex={-1}
              disabled={renameClashes || !trimmedNewName}
              aria-label={t('common.save')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleRenameSubmit}
              className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-green-600 disabled:pointer-events-none disabled:opacity-40"
            >
              <Check size={12} />
            </button>
          </span>
        </div>
        {childItems}
      </div>
    )
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
              'flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
              isActive && !isFolder && 'bg-accent text-accent-foreground',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {icon}
            <span className="truncate">{file.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleStartRename} disabled={!canWrite}>
            <Pencil size={14} />
            {t('sql_scripts.rename')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={!canDelete}
            onClick={() => onDelete(file.id)}
          >
            <Trash2 size={14} />
            {t('sql_scripts.delete_file')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {childItems}
    </div>
  )
}
