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
  getChildren: (parentId: string) => SqlScriptFile[]
  expandedFolders: Set<string>
  selectedFileId: string | null
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const inputRef = useRef<HTMLInputElement>(null)
  // True until the first selection is applied — prevents re-selecting on every
  // later focus (e.g. clicking into the field to place the cursor).
  const needsSelectRef = useRef(false)

  useEffect(() => {
    if (!editing) return
    needsSelectRef.current = true
    // The context menu closes a frame or two after rename starts and restores
    // focus to its trigger; poll focus across a few frames so we win the race
    // and select once it finally lands on the input.
    let tries = 0
    let raf = 0
    const tick = () => {
      const el = inputRef.current
      if (el && needsSelectRef.current) {
        if (document.activeElement !== el) el.focus()
        if (document.activeElement === el) {
          el.select()
          needsSelectRef.current = false
          return
        }
      }
      if (tries++ < 10) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
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
    needsSelectRef.current = true  // set now so onCloseAutoFocus sees it synchronously
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
              'flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
              isActive && !isFolder && 'bg-accent text-accent-foreground',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {isFolder ? (
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
            )}
            {editing ? (
              // -ml-1 offsets the border+padding so the text sits at the same x
              // as the static name (no jump between view/edit). min-w-0 lets the
              // whole field shrink with the sidebar instead of clipping.
              <span
                className="-ml-1 flex min-w-0 flex-1 items-center rounded border border-primary bg-background"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  ref={inputRef}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    // Keep rename keys local — Escape must not bubble to the page
                    // (it would exit fullscreen), nor Enter to any global handler.
                    e.stopPropagation()
                    if (e.key === 'Enter') handleRenameSubmit()
                    else if (e.key === 'Escape') setEditing(false)
                  }}
                  className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
                />
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t('common.cancel')}
                  onClick={(e) => { e.stopPropagation(); setEditing(false) }}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <X size={12} />
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t('common.save')}
                  onClick={(e) => { e.stopPropagation(); handleRenameSubmit() }}
                  className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-green-600"
                >
                  <Check size={12} />
                </span>
              </span>
            ) : (
              <span className="truncate">{file.name}</span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            // When closing to start a rename, don't let Radix return focus to the
            // trigger — that blur would clear the input's initial text selection.
            if (needsSelectRef.current) e.preventDefault()
          }}
        >
          <ContextMenuItem onClick={handleStartRename}>
            <Pencil size={14} />
            {t('sql_scripts.rename')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDelete(file.id)}
          >
            <Trash2 size={14} />
            {t('sql_scripts.delete_file')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isFolder && isExpanded && getChildren(file.id).map((child) => (
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
          getChildren={getChildren}
          expandedFolders={expandedFolders}
          selectedFileId={selectedFileId}
        />
      ))}
    </div>
  )
}
