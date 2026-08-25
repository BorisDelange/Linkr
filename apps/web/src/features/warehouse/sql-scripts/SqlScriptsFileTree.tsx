import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
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
import { downloadBlob } from '@/lib/entity-io'
import { isReservedTreeName, reservedTreeNameReason, treeNodePath } from '@/lib/entity-tree'
import {
  EMPTY_SELECTION,
  actionableTargets,
  isRowInBulkSelection,
  pruneSelection,
  selectOnClick,
  type ClickModifiers,
  type Selection,
} from '@/lib/tree-selection'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { FileTreeHeader, type FileTreeSort } from '@/components/ui/file-tree-header'
import { compareTreeNodes, contentSize } from '@/lib/file-tree-sort'
import { humanBytes } from '@/lib/format-helpers'
import { treeSearchMatches } from '@/components/SidebarSearch'
import type { SqlScriptFile } from '@/types'

interface Props {
  /** Open the create dialog targeting a folder (null = root). */
  onNewChild: (parentId: string | null, folderMode: boolean) => void
  /** Name filter from the explorer search box; empty shows the whole tree. */
  search?: string
}

export function SqlScriptsFileTree({ onNewChild, search = '' }: Props) {
  const { t } = useTranslation()
  const { files, selectedFileId, selectFile, deleteFile, updateFile, moveFile, duplicateFile } =
    useSqlScriptsStore()
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  // From the subscribed `files`, so every row's bulk state re-renders with the tree.
  const isFileId = useCallback(
    (id: string) => files.find((f) => f.id === id)?.type === 'file',
    [files],
  )
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null)
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

  const searchMatches = useMemo(() => treeSearchMatches(files, search), [files, search])
  const isVisible = (f: SqlScriptFile) => !searchMatches || searchMatches.has(f.id)
  // While searching, folders on a match's path open regardless of their stored
  // state, and close back to it when the search clears.
  const effectiveExpanded = useMemo(
    () => (searchMatches ? new Set([...expandedFolders, ...searchMatches]) : expandedFolders),
    [searchMatches, expandedFolders],
  )

  const rootFiles = files.filter((f) => f.parentId === null && isVisible(f))
  // Alphabetical like every other explorer. `order` is still what the drag
  // handles write and what execution follows; it is simply not a display sort.
  const compare = (a: SqlScriptFile, b: SqlScriptFile) => compareTreeNodes(
    { name: a.name, type: a.type, size: contentSize(a.content) },
    { name: b.name, type: b.type, size: contentSize(b.content) },
    sort,
  )
  const getChildren = (parentId: string) =>
    files.filter((f) => f.parentId === parentId && isVisible(f)).sort(compare)

  /** Ids in on-screen order, so a Shift-range cannot reach into a collapsed folder. */
  const visibleIds = useMemo(() => {
    const out: string[] = []
    const walk = (list: SqlScriptFile[]) => {
      for (const n of list) {
        out.push(n.id)
        if (n.type === 'folder' && effectiveExpanded.has(n.id)) walk(getChildren(n.id))
      }
    }
    walk([...rootFiles].sort(compare))
    return out
  // rootFiles/getChildren/compare derive from files+sort, both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, sort, effectiveExpanded])

  // A deleted file must not stay selected: a bulk action would misreport its count.
  useEffect(() => {
    setSelection((prev) => pruneSelection(prev, files.map((f) => f.id)))
  }, [files])

  const handleClickFile = (id: string, modifiers: ClickModifiers) => {
    setSelection((prev) => selectOnClick(prev, id, visibleIds, modifiers))
  }

  const pathOf = (id: string) => {
    const node = files.find((f) => f.id === id)
    return node ? treeNodePath(node, new Map(files.map((f) => [f.id, f]))) : ''
  }

  /** One file downloads as itself; several as a zip, keeping their tree paths. */
  const handleBulkDownload = async (ids: string[]) => {
    const targets = ids
      .map((id) => files.find((f) => f.id === id))
      .filter((f): f is SqlScriptFile => !!f && f.type === 'file')
    if (targets.length === 0) return
    if (targets.length === 1) {
      downloadBlob(new Blob([targets[0].content ?? ''], { type: 'text/plain' }), targets[0].name)
      return
    }
    // Imported lazily: JSZip is large and only a multi-file download needs it.
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    for (const f of targets) zip.file(pathOf(f.id) || f.name, f.content ?? '')
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'sql-scripts.zip')
  }
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

  if (files.length === 0 || rootFiles.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <FileCode size={24} className="text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">
          {searchMatches ? t('files.no_files_match') : t('sql_scripts.no_files')}
        </p>
      </div>
    )
  }

  return (
    <>
      <FileTreeHeader sort={sort} onChange={setSort} />
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
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
              isExpanded={effectiveExpanded.has(file.id)}
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
              expandedFolders={effectiveExpanded}
              selectedFileId={selectedFileId}
              selection={selection}
              onClickFile={handleClickFile}
              onBulkDownload={handleBulkDownload}
              onBulkDelete={setBulkDeleteIds}
              isFileId={isFileId}
            />
          ))}
        </div>
      </ScrollArea>

      <AlertDialog open={!!bulkDeleteIds} onOpenChange={(open) => { if (!open) setBulkDeleteIds(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sql_scripts.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('files.delete_confirm_count', { count: bulkDeleteIds?.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                for (const id of bulkDeleteIds ?? []) deleteFile(id)
                setBulkDeleteIds(null)
                setSelection(EMPTY_SELECTION)
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('files.delete_count', { count: bulkDeleteIds?.length ?? 0 })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
  selection,
  onClickFile,
  isFileId,
  onBulkDownload,
  onBulkDelete,
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
  selection: Selection
  onClickFile: (id: string, modifiers: ClickModifiers) => void
  onBulkDownload: (ids: string[]) => void
  onBulkDelete: (ids: string[]) => void
  isFileId: (id: string) => boolean
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
  const renameReserved = !!trimmedNewName && isReservedTreeName(trimmedNewName, file.parentId)
  const renameClashes =
    !!trimmedNewName &&
    trimmedNewName.toLowerCase() !== file.name.toLowerCase() &&
    nameExists(file.parentId, trimmedNewName, file.id)
  const renameInvalid = renameClashes || renameReserved

  const handleRenameSubmit = () => {
    if (!trimmedNewName || renameInvalid) return
    if (trimmedNewName !== file.name) {
      onRename(file.id, trimmedNewName)
    }
    setEditing(false)
  }

  const handleStartRename = () => {
    setEditName(file.name)
    setEditing(true)
  }

  // Only past one row: a plain click leaves one id selected, and decorating that
  // would dress up ordinary file opening as a multi-selection.
  // Tint and `bulk` from the SAME actionable set: a shift-range can sweep in a
  // folder, and these actions are file-only — deriving them apart made a row look
  // selected for a Delete that would skip it. `isFileId` comes from the subscribed
  // root rather than a getState() read, which bypassed the subscription and left
  // this stale until some other prop forced a re-render.
  const isMultiSelected = isRowInBulkSelection(selection, file.id, isFileId)
  const { ids: targetIds, bulk } = actionableTargets(selection, file.id, isFileId)
  const targetCount = targetIds.length

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
            selection={selection}
            onClickFile={onClickFile}
            onBulkDownload={onBulkDownload}
            onBulkDelete={onBulkDelete}
            isFileId={isFileId}
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
            renameInvalid ? 'border-destructive' : 'border-primary',
          )}>
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              title={renameReserved ? t(reservedTreeNameReason(trimmedNewName)) : renameClashes ? t('sql_scripts.name_exists', { name: trimmedNewName }) : undefined}
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
              disabled={renameInvalid || !trimmedNewName}
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
            onClick={(e) => {
              if (isFolder) {
                onToggleFolder(file.id)
                return
              }
              // metaKey is Cmd on Mac, ctrlKey elsewhere: accept either.
              const modifiers = { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }
              onClickFile(file.id, modifiers)
              // A modified click builds the selection; it must not also open the file.
              if (!modifiers.meta && !modifiers.shift) onSelect(file.id)
            }}
            {...nameTriggerProps}
            className={cn(
              'flex h-6 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
              isActive && !isFolder && 'bg-accent text-accent-foreground',
              // One look for every selected row, the open file included.
              isMultiSelected && 'border-l-2 border-l-primary bg-primary/10 text-foreground',
              dragOver && 'bg-accent/70 ring-1 ring-primary/50',
            )}
            style={{ paddingLeft: `${depth * 16 + 8 - (isMultiSelected ? 2 : 0)}px` }}
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
          {isFolder && !bulk && (
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
          {/* Single-file operations, hidden for a multi-selection: there is no one
              name to rename to. */}
          {!bulk && (
            <ContextMenuItem onClick={handleStartRename} disabled={!canWrite}>
              <Pencil size={14} />
              {t('sql_scripts.rename')}
            </ContextMenuItem>
          )}
          {!isFolder && !bulk && (
            <ContextMenuItem onClick={() => onDuplicate(file.id)} disabled={!canWrite}>
              <Copy size={14} />
              {t('files.duplicate')}
            </ContextMenuItem>
          )}
          {!isFolder && (
            <ContextMenuItem onClick={() => void onBulkDownload(targetIds)}>
              <Download size={14} />
              {bulk ? t('files.download_count', { count: targetCount }) : t('files.download')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={!canDelete}
            onClick={() => (bulk ? onBulkDelete(targetIds) : onDelete(file.id))}
          >
            <Trash2 size={14} />
            {bulk ? t('files.delete_count', { count: targetCount }) : t('sql_scripts.delete_file')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
        {nameOverflows && <TooltipContent side="right">{file.name}</TooltipContent>}
      </Tooltip>

      {childItems}
    </div>
  )
}
