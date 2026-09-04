import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Database,
  File,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderUp,
  Loader2,
  RotateCcw,
  Search,
} from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fsBrowse, type FsEntry, type FsListing, type FsScope } from '@/lib/api/fs-browser'
import { formatApiError } from '@/lib/api-client'
import { cn } from '@/lib/utils'

/** Extension → icon + colour, extending the IDE file-list scheme (`PluginFileList`)
 *  with the data formats a database points at. Folders are amber everywhere. */
function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'duckdb' || ext === 'db' || ext === 'sqlite' || ext === 'sqlite3')
    return <Database size={15} className="shrink-0 text-violet-500" />
  if (ext === 'parquet' || ext === 'pq')
    return <FileSpreadsheet size={15} className="shrink-0 text-sky-500" />
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls')
    return <FileSpreadsheet size={15} className="shrink-0 text-emerald-500" />
  if (ext === 'json') return <FileJson size={15} className="shrink-0 text-green-400" />
  if (ext === 'md' || ext === 'txt')
    return <FileText size={15} className="shrink-0 text-muted-foreground" />
  if (ext === 'sql') return <FileCode size={15} className="shrink-0 text-orange-400" />
  if (ext === 'py') return <FileCode size={15} className="shrink-0 text-yellow-500" />
  if (ext === 'r') return <FileCode size={15} className="shrink-0 text-blue-500" />
  return <File size={15} className="shrink-0 text-muted-foreground" />
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

interface Props {
  open: boolean
  /** `folder` returns the folder being browsed; `file` returns the selected file.
   *  Files are listed in both modes — in `folder` they are shown disabled, so a
   *  folder can be recognised by what it holds. */
  mode: 'folder' | 'file'
  scope: FsScope
  /** Display filter for files, e.g. ['.parquet']. Never a security boundary. */
  extensions?: string[]
  initialPath?: string
  /** A "reset to default" button jumps here; the user still confirms. */
  defaultPath?: string
  title?: string
  onClose: () => void
  onPick: (path: string) => void
}

/** Browses the server filesystem and returns an absolute path. Server mode only:
 *  a client-only build has no server to browse. */
export function ServerPathPickerDialog({
  open,
  mode,
  scope,
  extensions,
  initialPath,
  defaultPath,
  title,
  onClose,
  onPick,
}: Props) {
  const { t } = useTranslation()
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedFile, setSelectedFile] = useState<FsEntry | null>(null)
  /** The path bar is editable: `pathDraft` is what the user is typing, `current`
   *  is the folder actually listed. They differ only mid-edit. */
  const [pathDraft, setPathDraft] = useState('')
  const [pathError, setPathError] = useState(false)

  const extKey = extensions?.join(',') ?? ''
  const load = useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      setSearch('')  // a fresh folder starts unfiltered
      setSelectedFile(null)  // ...and the previous folder's pick is void
      try {
        // Every file is listed, `extensions` only decides which are selectable.
        // Filtering server-side made a folder holding no match look empty — the
        // root, with no .duckdb in it, read as "folders only".
        const next = await fsBrowse(scope, path, { includeFiles: true })
        setListing(next)
        setPathDraft(next.path)
        setPathError(false)
        return true
      } catch (e) {
        const fe = formatApiError(e)
        setError(fe.summary ?? fe.detail ?? String(e))
        return false
      } finally {
        setLoading(false)
      }
    },
    // `scope` is an inline object at every call site; keying on its parts keeps
    // this callback stable instead of reloading on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.kind, scope.kind === 'project' ? scope.projectUid : scope.workspaceId, extKey],
  )

  useEffect(() => {
    if (open) void load(initialPath ?? '')
  }, [open, initialPath, load])

  /** Navigate to whatever was typed in the path bar. A path that does not exist
   *  (or sits outside the browse roots) leaves the current folder listed and
   *  flags the input — losing the listing over a typo would be worse. */
  const goToPath = async () => {
    const target = pathDraft.trim()
    if (!target || target === current) {
      setPathDraft(current)
      setPathError(false)
      return
    }
    setPathError(false)
    try {
      const next = await fsBrowse(scope, target, { includeFiles: true })
      setListing(next)
      setPathDraft(next.path)
      setSearch('')
      setSelectedFile(null)
      setError(null)
    } catch {
      setPathError(true)
    }
  }

  const current = listing?.path ?? ''
  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    const entries = listing?.entries ?? []
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
  }, [listing, search])

  /** Whether a file may be picked, given the caller's extension filter. Every
   *  file is listed either way; this only decides what is clickable. */
  const matchesExtension = (name: string) => {
    if (!extensions?.length) return true
    const lower = name.toLowerCase()
    return extensions.some((ext) => {
      const suffix = ext.trim().toLowerCase()
      return suffix && lower.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`)
    })
  }

  const pickingFile = mode === 'file'
  const chosen = pickingFile ? selectedFile?.path : current
  const confirm = () => {
    if (chosen) {
      onPick(chosen)
      onClose()
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kind="workbench"
      // Narrower than a workbench's 5xl: this is one column of file names, and at
      // full width the rows were mostly empty space between a name and its size.
      className="sm:max-w-2xl"
      title={title ?? t(pickingFile ? 'server_picker.pick_file' : 'project_folders.pick_folder')}
      onConfirm={confirm}
      confirmLabel={t(pickingFile ? 'server_picker.select_file' : 'project_folders.select_this_folder')}
      confirmDisabled={!chosen}
      // The workbench body scrolls as one block by default; here the path bar and
      // the search stay put and only the listing scrolls, so it becomes a flex
      // column that owns its own spacing. `overflow-visible` matters: the inputs'
      // focus ring is drawn outside their border box, and a clipping body cut it
      // off against the dialog's left and right edges.
      contentClassName="flex flex-col gap-3 overflow-visible"
      footerExtra={
        defaultPath ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => load(defaultPath)}
          >
            <RotateCcw size={13} />
            {t('project_folders.reset_to_default')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-2">
        {/* Enter here navigates to the typed path; it must NOT reach the shell's
            confirm-on-Enter, which would select whatever is currently highlighted. */}
        <div className="relative" data-no-enter-submit>
          <Folder
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-amber-500"
          />
          <Input
            value={pathDraft}
            onChange={(e) => { setPathDraft(e.target.value); setPathError(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void goToPath() }
              // Escape reverts the draft rather than closing the dialog.
              if (e.key === 'Escape' && pathDraft !== current) {
                e.preventDefault()
                e.stopPropagation()
                setPathDraft(current)
                setPathError(false)
              }
            }}
            onBlur={() => { if (pathDraft !== current) void goToPath() }}
            spellCheck={false}
            aria-invalid={pathError}
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>
        {pathError && (
          <p className="text-xs text-destructive">{t('server_picker.path_not_found')}</p>
        )}

        {/* Same reason: Enter while filtering must not pick the highlighted row. */}
        <div className="relative" data-no-enter-submit>
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(pickingFile ? 'server_picker.search' : 'project_folders.search_folders')}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Takes the rest of the dialog: a fixed-height list left the lower half of
          a workbench dialog empty while the folder above it scrolled. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
            {error}
          </div>
        ) : (
          <ScrollArea className="h-full">
            {/* pr-3 clears the scrollbar: it is an overlay, so it sat on top of
                the chevrons and the file sizes at the right edge. */}
            <div className="py-1 pr-3">
              {listing?.parent != null && !search && (
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => load(listing.parent as string)}
                >
                  <FolderUp size={15} className="text-muted-foreground" />
                  <span>..</span>
                </button>
              )}
              {filteredEntries.length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {search ? t('server_picker.no_match') : t('server_picker.empty')}
                </p>
              )}
              {filteredEntries.map((e) => {
                const isDir = e.isDir !== false
                // In folder mode a file is context, not a target; an unreadable
                // file, or one the extension filter excludes, is shown disabled
                // rather than hidden — so a wrong-permissions mount stays
                // diagnosable and a folder never looks empty when it is not.
                const selectable =
                  isDir || (pickingFile && e.readable !== false && matchesExtension(e.name))
                const isSelected = !isDir && selectedFile?.path === e.path
                return (
                  <button
                    key={e.path}
                    disabled={!selectable}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                      selectable ? 'hover:bg-accent' : 'cursor-default opacity-50',
                      isSelected && 'bg-accent',
                    )}
                    onClick={() => {
                      if (!selectable) return
                      if (isDir) load(e.path)
                      else setSelectedFile(e)
                    }}
                  >
                    {isDir ? (
                      <Folder size={15} className="shrink-0 text-amber-500" />
                    ) : (
                      fileIcon(e.name)
                    )}
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {!isDir && e.size != null && (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {formatSize(e.size)}
                      </span>
                    )}
                    {isDir && (
                      <ChevronRight size={14} className="shrink-0 text-muted-foreground/60" />
                    )}
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </DialogShell>
  )
}
