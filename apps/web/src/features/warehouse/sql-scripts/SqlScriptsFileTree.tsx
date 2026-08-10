import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Trash2,
  Pencil,
  Copy,
  Download,
  FilePlus,
  FolderPlus,
  Check,
  X,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
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
import { FileTreeHeader, type FileTreeSort } from '@/components/ui/file-tree-header'
import { compareTreeNodes, contentSize } from '@/lib/file-tree-sort'
import { humanBytes } from '@/lib/format-helpers'
import type { SqlScriptFile } from '@/types'

interface Props {
  /** Open the create dialog targeting a folder (null = root). */
  onNewChild: (parentId: string | null, folderMode: boolean) => void
}

export function SqlScriptsFileTree({ onNewChild }: Props) {
  const { t } = useTranslation()
  const { files, selectedFileId, selectFile, deleteFile, updateFile, moveFile, duplicateFile } =
    useSqlScriptsStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [deleteConfirmFileId, setDeleteConfirmFileId] = useState<string | null>(null)
  const [rootDragOver, setRootDragOver] = useState(false)
  const [sort, setSort] = useState<FileTreeSort>({ key: 'name', desc: false })

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

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
  // Alphabetical like every other explorer. `order` is still what the drag
  // handles write and what execution follows; it is simply not a display sort.
  const compare = (a: SqlScriptFile, b: SqlScriptFile) => compareTreeNodes(
    { name: a.name, type: a.type, size: contentSize(a.content) },
    { name: b.name, type: b.type, size: contentSize(b.content) },
    sort,
  )
  const getChildren = (parentId: string) =>
    files.filter((f) => f.parentId === parentId).sort(compare)
  // True if another node under the same parent already has this name (rename guard).
  const nameExists = (parentId: string | null, name: string, exceptId: string) =>
    files.some(
      (f) => f.parentId === parentId && f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase(),
    )

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setRootDragOver(false)
    const draggedId = e.dataTransfer.getData('text/plain')
    if (!draggedId) return
    const node = files.find((f) => f.id === draggedId)
    if (!node || node.parentId === null) return
    moveFile(draggedId, null)
  }

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
      <FileTreeHeader sort={sort} onChange={setSort} />
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div
          className={cn('min-h-full py-1', rootDragOver && 'bg-accent/30')}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setRootDragOver(true) }}
          onDragLeave={() => setRootDragOver(false)}
          onDrop={handleRootDrop}
        >
          {[...rootFiles].sort(compare).map((file) => (
            <SqlScriptsFileTreeItem
              key={file.id}
              file={file}
              depth={0}
              isActive={file.id === selectedFileId}
              isFolder={file.type === 'folder'}
              isExpanded={expandedFolders.has(file.id)}
              onToggleFolder={toggleFolder}
              onExpandFolder={expandFolder}
              onSelect={selectFile}
              onDelete={handleDeleteRequest}
              onRename={(id, name) => updateFile(id, { name })}
              onMove={moveFile}
              onDuplicate={duplicateFile}
              onNewChild={onNewChild}
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

function getAllDescendantIds(files: SqlScriptFile[], parentId: string): string[] {
  const ids = [parentId]
  for (const child of files.filter((f) => f.parentId === parentId)) {
    ids.push(...getAllDescendantIds(files, child.id))
  }
  return ids
}

function SqlScriptsFileTreeItem({
  file,
  depth,
  isActive,
  isFolder,
  isExpanded,
  onToggleFolder,
  onExpandFolder,
  onSelect,
  onDelete,
  onRename,
  onMove,
  onDuplicate,
  onNewChild,
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
  onExpandFolder: (id: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onMove: (id: string, parentId: string | null) => void
  onDuplicate: (id: string) => void
  onNewChild: (parentId: string | null, folderMode: boolean) => void
  nameExists: (parentId: string | null, name: string, exceptId: string) => boolean
  getChildren: (parentId: string) => SqlScriptFile[]
  expandedFolders: Set<string>
  selectedFileId: string | null
}) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('sql-scripts:write')
  const canDelete = useMyWorkspaceRole().can('sql-scripts:delete')
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { ref: nameRef, overflows: nameOverflows, triggerProps: nameTriggerProps } = useOverflowTooltip()

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

  const handleDownload = () => {
    if (isFolder) return
    const blob = new Blob([file.content ?? ''], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', file.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent) => {
    // Dropping on a folder moves into it; dropping on a file moves into that
    // file's parent (so dropping next to a root file lands at the root).
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (isFolder) setDragOver(true)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const draggedId = e.dataTransfer.getData('text/plain')
    if (!draggedId || draggedId === file.id) return
    const targetParentId = isFolder ? file.id : file.parentId
    // Reject dropping a folder into itself or one of its descendants.
    const allFiles = useSqlScriptsStore.getState().files
    if (targetParentId && getAllDescendantIds(allFiles, draggedId).includes(targetParentId)) return
    onMove(draggedId, targetParentId)
    if (isFolder) onExpandFolder(file.id)
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
            onExpandFolder={onExpandFolder}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
            onMove={onMove}
            onDuplicate={onDuplicate}
            onNewChild={onNewChild}
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
      {file.name.endsWith('.md') ? (
        <FileText size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <FileCode size={14} className="shrink-0 text-orange-400" />
      )}
    </>
  )

  // Editing renders a plain row (no <button>/ContextMenuTrigger): an <input>
  // nested in a <button> is invalid HTML and made the button steal focus/keys
  // (selection cleared, Escape leaked). A div keeps the input fully in control.
  // The row keeps the exact height of a non-editing row (h-6 / gap / paddings)
  // so starting a rename doesn't shift the tree.
  if (editing) {
    return (
      <div>
        <div
          className="flex h-6 w-full min-w-0 items-center gap-1.5 pr-2 text-xs"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {icon}
          <span className={cn(
            '-ml-1 flex h-5 min-w-0 flex-1 items-center gap-0.5 rounded border bg-background pr-0.5',
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
              className="w-0 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('common.cancel')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing(false)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <X size={11} />
            </button>
            <button
              type="button"
              tabIndex={-1}
              disabled={renameClashes || !trimmedNewName}
              aria-label={t('common.save')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleRenameSubmit}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-green-600 disabled:pointer-events-none disabled:opacity-40"
            >
              <Check size={11} />
            </button>
          </span>
        </div>
        {childItems}
      </div>
    )
  }

  return (
    <div>
      <Tooltip>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
          <button
            draggable
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => {
              if (isFolder) onToggleFolder(file.id)
              else onSelect(file.id)
            }}
            {...nameTriggerProps}
            className={cn(
              'flex h-6 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
              isActive && !isFolder && 'bg-accent text-accent-foreground',
              dragOver && 'bg-accent/70 ring-1 ring-primary/50',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {icon}
            <span ref={nameRef} className="truncate">{file.name}</span>
            {/* Discreet and last, so it answers "which is the big one" without
                competing with the name. */}
            {file.type === 'file' && contentSize(file.content) != null && (
              <span className="ml-auto shrink-0 pl-1 text-[10px] tabular-nums text-muted-foreground/60">
                {humanBytes(contentSize(file.content), i18n.language)}
              </span>
            )}
          </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isFolder && (
            <>
              <ContextMenuItem onClick={() => onNewChild(file.id, false)} disabled={!canWrite}>
                <FilePlus size={14} />
                {t('sql_scripts.new_file')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewChild(file.id, true)} disabled={!canWrite}>
                <FolderPlus size={14} />
                {t('files.new_folder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={handleStartRename} disabled={!canWrite}>
            <Pencil size={14} />
            {t('sql_scripts.rename')}
          </ContextMenuItem>
          {!isFolder && (
            <ContextMenuItem onClick={() => onDuplicate(file.id)} disabled={!canWrite}>
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
            variant="destructive"
            disabled={!canDelete}
            onClick={() => onDelete(file.id)}
          >
            <Trash2 size={14} />
            {t('sql_scripts.delete_file')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
        {nameOverflows && <TooltipContent side="right">{file.name}</TooltipContent>}
      </Tooltip>

      {childItems}
    </div>
  )
}
