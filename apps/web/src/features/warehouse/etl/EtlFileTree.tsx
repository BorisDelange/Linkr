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
  Check,
  X,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  MinusCircle,
  Square,
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
import { useEtlStore } from '@/stores/etl-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
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

/** Documentation files get the plain-document icon, as in the IDE file tree. */
function FileTypeIcon({ file }: { file: EtlFile }) {
  const isMarkdown = file.language === 'markdown' || file.name.toLowerCase().endsWith('.md')
  const className = cn('shrink-0', getFileColor(file))
  return isMarkdown
    ? <FileText size={14} className={className} />
    : <FileCode size={14} className={className} />
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

  // True if another node under the same parent already has this name (rename guard).
  const nameExists = (parentId: string | null, name: string, exceptId: string) =>
    files.some(
      (f) => f.parentId === parentId && f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase(),
    )

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
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
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
            <AlertDialogTitle>{t('etl.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmFile?.type === 'folder'
                ? t('etl.delete_confirm_folder', { name: deleteConfirmFile?.name ?? '' })
                : t('etl.delete_confirm_file', { name: deleteConfirmFile?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-white hover:bg-destructive/90">
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
  nameExists,
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
  nameExists: (parentId: string | null, name: string, exceptId: string) => boolean
  getChildren: (parentId: string) => EtlFile[]
  expandedFolders: Set<string>
  selectedFileId: string | null
}) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const canDelete = useMyWorkspaceRole().can('etl:delete')
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const { ref: nameRef, overflows: nameOverflows, triggerProps: nameTriggerProps } = useOverflowTooltip()

  useEffect(() => {
    if (!editing || !inputRef.current) return
    const input = inputRef.current
    input.focus()
    // Select the base name (before the extension) for files so a rename keeps the
    // extension by default; select all for folders (no extension).
    const dot = file.name.lastIndexOf('.')
    if (!isFolder && dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }, [editing, file.name, isFolder])

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

  // An <input> nested in the row <button> is invalid HTML and lets the button
  // steal focus/keys; render the editing row as a plain div instead.
  if (editing) {
    return (
      <div>
        <div
          className="flex h-6 w-full min-w-0 items-center gap-1.5 pr-2 text-xs"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <span className="w-3 shrink-0" />
          <FileTypeIcon file={file} />
          <span
            className={cn(
              '-ml-0.5 flex h-5 min-w-0 flex-1 items-center gap-0.5 rounded border bg-background pr-0.5',
              renameClashes ? 'border-destructive' : 'border-primary',
            )}
          >
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              title={renameClashes ? t('etl.name_exists', { name: trimmedNewName }) : undefined}
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
            nameExists={nameExists}
            getChildren={getChildren}
            expandedFolders={expandedFolders}
            selectedFileId={selectedFileId}
          />
        ))}
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
            onClick={() => {
              if (isFolder) onToggleFolder(file.id)
              else onSelect(file.id)
            }}
            {...nameTriggerProps}
            className={cn(
              'flex h-6 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
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
                <FileTypeIcon file={file} />
              </>
            )}
            <span ref={nameRef} className="truncate">{file.name}</span>
            {/* Where the run is: the tree is where the scripts are listed, so the
                status belongs here and not only in the Pipeline tab's DAG. */}
            <ScriptRunStatus fileId={file.id} />
          </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleStartRename} disabled={!canWrite}>
            <Pencil size={14} />
            {t('etl.rename')}
          </ContextMenuItem>
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
            {t('etl.delete_file')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
        {nameOverflows && <TooltipContent side="right">{file.name}</TooltipContent>}
      </Tooltip>

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
          nameExists={nameExists}
          getChildren={getChildren}
          expandedFolders={expandedFolders}
          selectedFileId={selectedFileId}
        />
      ))}
    </div>
  )
}

/**
 * Run status of one script, shown inline in the tree while a pipeline runs.
 * Subscribes to just this file's entry, so a status change re-renders one row.
 */
function ScriptRunStatus({ fileId }: { fileId: string }) {
  const { t } = useTranslation()
  const log = useEtlStore((s) => s.scriptStatuses.get(fileId))
  if (!log) return null

  const cls = 'ml-auto shrink-0'
  const icon = (() => {
    switch (log.status) {
      case 'running': return <Loader2 size={11} className={cn(cls, 'animate-spin text-blue-500')} />
      case 'success': return <CheckCircle2 size={11} className={cn(cls, 'text-emerald-500')} />
      case 'error': return <AlertCircle size={11} className={cn(cls, 'text-red-500')} />
      case 'skipped': return <MinusCircle size={11} className={cn(cls, 'text-muted-foreground/40')} />
      case 'stopped': return <Square size={11} className={cn(cls, 'text-amber-500')} />
      default: return null
    }
  })()
  if (!icon) return null

  // A native title, not a Tooltip: the row already wraps one for the file name,
  // and nesting two triggers on the same element fights over the hover.
  return (
    <span className="ml-auto inline-flex shrink-0" title={t(`etl.run_status_${log.status}`)}>
      {icon}
    </span>
  )
}
