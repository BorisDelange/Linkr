import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
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
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  MinusCircle,
  Square,
  GitCommitVertical,
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
import { isVersioned, toggleVersioned, setVersionedMany } from './etl-versioning'
import { FileTreeHeader, type FileTreeSort } from '@/components/ui/file-tree-header'
import { compareTreeNodes, contentSize, sizeColumnWidthCh } from '@/lib/file-tree-sort'
import { humanBytes } from '@/lib/format-helpers'
import { treeNodePath } from '@/lib/entity-tree'
import { downloadBlob } from '@/lib/entity-io'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import {
  EMPTY_SELECTION,
  actionTargets,
  pruneSelection,
  selectOnClick,
  type ClickModifiers,
  type Selection,
} from '@/lib/tree-selection'
import type { EtlFile } from '@/types'

export function EtlFileTree() {
  const { t, i18n } = useTranslation()
  const { files, selectedFileId, selectFile, deleteFile, updateFile, etlPipelines, updatePipeline } = useEtlStore()
  const [sort, setSort] = useState<FileTreeSort>({ key: 'name', desc: false })
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [deleteConfirmFileId, setDeleteConfirmFileId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  /** Ids a context-menu action is about to act on, once confirmed. */
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null)

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

  // Not by `order`: that is the Pipeline tab's execution sequence, and using it
  // here listed 35_… before 10_… simply because it was created first.
  const compare = (a: EtlFile, b: EtlFile) => compareTreeNodes(
    { name: a.name, type: a.type, size: contentSize(a.content) },
    { name: b.name, type: b.type, size: contentSize(b.content) },
    sort,
  )
  // One width for every row, measured from the sizes actually shown: a fixed
  // width sized for "1000 ko" left a gap when every file is "5 ko".
  const sizeWidthCh = sizeColumnWidthCh(
    files.map((f) => {
      const bytes = f.type === 'file' ? contentSize(f.content) : undefined
      return bytes == null ? undefined : humanBytes(bytes, i18n.language)
    }),
  )
  const rootFiles = files.filter((f) => f.parentId === null)
  const getChildren = (parentId: string) =>
    files.filter((f) => f.parentId === parentId).sort(compare)

  /**
   * Ids in the order they appear ON SCREEN, which is what a Shift-range means:
   * a collapsed folder's children are not between two visible rows, so they must
   * not be swept in.
   */
  const visibleIds = useMemo(() => {
    const out: string[] = []
    const walk = (nodes: EtlFile[]) => {
      for (const node of nodes) {
        out.push(node.id)
        if (node.type === 'folder' && expandedFolders.has(node.id)) walk(getChildren(node.id))
      }
    }
    walk([...rootFiles].sort(compare))
    return out
  // getChildren/compare are derived from files+sort, which are both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, sort, expandedFolders])

  // A deleted or renamed-away file must not stay selected: a bulk action would
  // report a count it cannot deliver.
  useEffect(() => {
    setSelection((prev) => pruneSelection(prev, files.map((f) => f.id)))
  }, [files])

  const pipelineId = rootFiles[0]?.pipelineId ?? files[0]?.pipelineId
  const pipelineConfig = etlPipelines.find((p) => p.id === pipelineId)?.config
  const pathOf = (id: string) => {
    const node = files.find((f) => f.id === id)
    return node ? treeNodePath(node, new Map(files.map((f) => [f.id, f]))) : ''
  }

  const handleClickFile = (id: string, modifiers: ClickModifiers) => {
    setSelection((prev) => selectOnClick(prev, id, visibleIds, modifiers))
  }

  /** Mark or unmark every selected FILE (folders have no versioning state). */
  const handleBulkVersioning = (ids: string[], versioned: boolean) => {
    if (!pipelineId) return
    const paths = ids
      .map((id) => files.find((f) => f.id === id))
      .filter((f): f is EtlFile => !!f && f.type === 'file')
      .map((f) => pathOf(f.id))
    if (paths.length === 0) return
    updatePipeline(pipelineId, { config: setVersionedMany(paths, versioned, pipelineConfig) })
  }

  /** One file downloads as itself; several as a zip, named after the pipeline. */
  const handleBulkDownload = async (ids: string[]) => {
    const targets = ids
      .map((id) => files.find((f) => f.id === id))
      .filter((f): f is EtlFile => !!f && f.type === 'file')
    if (targets.length === 0) return

    if (targets.length === 1) {
      downloadBlob(new Blob([targets[0].content ?? ''], { type: 'text/plain' }), targets[0].name)
      return
    }
    // Imported lazily: JSZip is large and only a multi-file download needs it.
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    // Full tree paths, so files from different folders cannot collide in the zip.
    for (const f of targets) zip.file(pathOf(f.id) || f.name, f.content ?? '')
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'etl-scripts.zip')
  }

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
      {/* Same right gutter as the rows (pr-3.5), so the "size" label stays above
          the values it heads once the scrollbar has its own lane. */}
      <FileTreeHeader sort={sort} onChange={setSort} className="pr-3.5" />
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="py-1">
          {[...rootFiles].sort(compare).map((file) => (
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
              sizeWidthCh={sizeWidthCh}
              selection={selection}
              onClickFile={handleClickFile}
              onBulkVersioning={handleBulkVersioning}
              onBulkDownload={handleBulkDownload}
              onBulkDelete={setBulkDeleteIds}
            />
          ))}
        </div>
      </ScrollArea>

      <AlertDialog open={!!bulkDeleteIds} onOpenChange={(open) => { if (!open) setBulkDeleteIds(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('etl.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('etl.delete_confirm_count', { count: bulkDeleteIds?.length ?? 0 })}
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
              {t('etl.delete_count', { count: bulkDeleteIds?.length ?? 0 })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
  sizeWidthCh,
  selection,
  onClickFile,
  onBulkVersioning,
  onBulkDownload,
  onBulkDelete,
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
  sizeWidthCh: number
  selection: Selection
  onClickFile: (id: string, modifiers: ClickModifiers) => void
  onBulkVersioning: (ids: string[], versioned: boolean) => void
  onBulkDownload: (ids: string[]) => void
  onBulkDelete: (ids: string[]) => void
}) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const canDelete = useMyWorkspaceRole().can('etl:delete')
  // Read from the store rather than threaded through props: the tree recurses,
  // and every level would otherwise have to forward state it does not use.
  const { files, etlPipelines, updatePipeline } = useEtlStore()
  const pipelineId = file.pipelineId
  const pipelineConfig = etlPipelines.find((p) => p.id === pipelineId)?.config
  const filePath = (id: string) => {
    const own = files.filter((f) => f.pipelineId === pipelineId)
    const node = own.find((f) => f.id === id)
    return node ? treeNodePath(node, new Map(own.map((f) => [f.id, f]))) : ''
  }
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

  // Versioning is decided by the file's PATH inside the pipeline, which is what
  // the export tree and the .gitignore exceptions key on — not by its id.
  const treePath = filePath(file.id)
  const size = contentSize(file.content)
  const versioned = isVersioned(treePath, pipelineConfig)
  const handleToggleVersioned = () => {
    if (!pipelineId) return
    updatePipeline(pipelineId, { config: toggleVersioned(treePath, pipelineConfig) })
  }

  // Only once the selection actually spans several rows: a plain click leaves one
  // id selected, and marking that row would decorate ordinary single-file opening
  // as if a multi-selection were under way.
  const isMultiSelected = selection.ids.length > 1 && selection.ids.includes(file.id)
  // Right-clicking inside a multi-selection acts on all of it; outside, on this
  // row alone (see lib/tree-selection.actionTargets).
  const targets = actionTargets(selection, file.id)
  const targetFiles = targets
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is EtlFile => !!f && f.type === 'file')
  const bulk = targetFiles.length > 1
  // A mixed selection offers "mark": the useful default is to bring everything
  // into the same state rather than to invert each file.
  const allVersioned = targetFiles.length > 0
    && targetFiles.every((f) => isVersioned(filePath(f.id), pipelineConfig))

  // An <input> nested in the row <button> is invalid HTML and lets the button
  // steal focus/keys; render the editing row as a plain div instead.
  if (editing) {
    return (
      <div>
        <div
          className="flex h-6 w-full min-w-0 items-center gap-1.5 pr-3.5 text-xs"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <span className="w-3 shrink-0" />
          <FileTypeIcon name={file.name} />
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
            sizeWidthCh={sizeWidthCh}
            selection={selection}
            onClickFile={onClickFile}
            onBulkVersioning={onBulkVersioning}
            onBulkDownload={onBulkDownload}
            onBulkDelete={onBulkDelete}
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
            onClick={(e) => {
              if (isFolder) {
                onToggleFolder(file.id)
                return
              }
              // metaKey is Cmd on Mac, ctrlKey elsewhere: accept either so the
              // shortcut is the one the platform's users expect.
              const modifiers = { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }
              onClickFile(file.id, modifiers)
              // A modified click extends the selection; it must not also open the
              // file, which would replace what the user is building.
              if (!modifiers.meta && !modifiers.shift) onSelect(file.id)
            }}
            {...nameTriggerProps}
            className={cn(
              'flex h-6 w-full min-w-0 items-center gap-1.5 pr-3.5 text-left text-xs transition-colors hover:bg-accent/50',
              isActive && !isFolder && 'bg-accent text-accent-foreground',
              // Selection is shown on EVERY selected row, the active one included:
              // guarding this with !isActive hid it on the first file clicked (which
              // is also the open file), so the anchor of the user's own selection
              // looked excluded from it. The active row stays distinguishable by its
              // left border instead of by having no selection tint.
              isMultiSelected && !isActive && 'bg-primary/10',
              isMultiSelected && isActive && 'bg-accent',
              isMultiSelected && 'border-l-2 border-l-primary',
            )}
            // The 2px selection border is subtracted from the indent, so the name
            // does not shift sideways when a row becomes selected.
            style={{ paddingLeft: `${depth * 16 + 8 - (isMultiSelected ? 2 : 0)}px` }}
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
                <FileTypeIcon name={file.name} />
              </>
            )}
            <span ref={nameRef} className="truncate">{file.name}</span>
            {/* Every marker is pushed to the end in a FIXED order — run status,
                then versioning, then size — so they line up in a column down the
                tree. Following the name instead made each one land at a different
                x depending on how long the filename was. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
              {/* Fixed-width slots, so every marker keeps the same x down the whole
                  tree. Laid out naturally, a two-character size ("5 ko" vs "10 ko")
                  shifted the versioning icon left and right from row to row. */}
              <span className="flex w-3 justify-center">
                {/* Where the run is: the tree is where the scripts are listed, so
                    the status belongs here and not only in the Pipeline tab's DAG. */}
                <ScriptRunStatus fileId={file.id} />
              </span>
              <span className="flex w-3 justify-center">
                {/* Same marker as the IDE (FileTreeItem): shown on every file git
                    will commit, whether that is a script by default or a data file
                    the user marked. */}
                {!isFolder && versioned && (
                  <GitCommitVertical
                    size={11}
                    className="text-primary"
                    aria-label={t('datasets.versioned_badge')}
                  />
                )}
              </span>
              {/* Discreet, and last: the size answers "which file is the big one"
                  without competing with the name for attention. Right-aligned in a
                  fixed box so the digits line up as a column. */}
              <span
                className="text-right text-[10px] tabular-nums text-muted-foreground/60"
                style={{ width: `${sizeWidthCh}ch` }}
              >
                {!isFolder && size != null ? humanBytes(size, i18n.language) : ''}
              </span>
            </span>
          </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Rename is single-file by nature: there is no sensible way to give
              several files one name, so a multi-selection simply does not offer it. */}
          {!bulk && (
            <ContextMenuItem onClick={handleStartRename} disabled={!canWrite}>
              <Pencil size={14} />
              {t('etl.rename')}
            </ContextMenuItem>
          )}
          {targetFiles.length > 0 && (
            <ContextMenuItem onClick={() => void onBulkDownload(targets)}>
              <Download size={14} />
              {/* Several files come down as one zip — a browser blocks a burst of
                  individual downloads anyway. */}
              {bulk
                ? t('etl.download_count', { count: targetFiles.length })
                : t('files.download')}
            </ContextMenuItem>
          )}
          {targetFiles.length > 0 && (
            <>
              <ContextMenuSeparator />
              {/* Same wording, icon and badge as the project IDE — the marking
                  means the same thing, so it must not look like a different
                  feature. Data files are gitignored by default and code files
                  versioned by default; this is the per-file exception either way. */}
              <ContextMenuItem
                onClick={() => (bulk
                  ? onBulkVersioning(targets, !allVersioned)
                  : handleToggleVersioned())}
                disabled={!canWrite}
              >
                <GitCommitVertical size={14} />
                {bulk
                  ? (allVersioned
                      ? t('etl.unmark_versioned_count', { count: targetFiles.length })
                      : t('etl.mark_versioned_count', { count: targetFiles.length }))
                  : (versioned ? t('datasets.unmark_versioned') : t('datasets.mark_versioned'))}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={!canDelete}
            onClick={() => (bulk ? onBulkDelete(targets) : onDelete(file.id))}
          >
            <Trash2 size={14} />
            {bulk
              ? t('etl.delete_count', { count: targetFiles.length })
              : t('etl.delete_file')}
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

  const cls = 'shrink-0'
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
    <span className="inline-flex shrink-0" title={t(`etl.run_status_${log.status}`)}>
      {icon}
    </span>
  )
}
