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

  const extKey = extensions?.join(',') ?? ''
  const load = useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      setSearch('')  // a fresh folder starts unfiltered
      setSelectedFile(null)  // ...and the previous folder's pick is void
      try {
        setListing(
          await fsBrowse(scope, path, {
            includeFiles: true,
            extensions: extKey ? extKey.split(',') : undefined,
          }),
        )
      } catch (e) {
        const fe = formatApiError(e)
        setError(fe.summary ?? fe.detail ?? String(e))
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
    if (open) load(initialPath ?? '')
  }, [open, initialPath, load])

  const current = listing?.path ?? ''
  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    const entries = listing?.entries ?? []
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
  }, [listing, search])

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
      title={title ?? t(pickingFile ? 'server_picker.pick_file' : 'project_folders.pick_folder')}
      onConfirm={confirm}
      confirmLabel={t(pickingFile ? 'server_picker.select_file' : 'project_folders.select_folder')}
      confirmDisabled={!chosen}
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
      <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
        <Folder size={14} className="shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate" title={chosen || current}>
          {chosen || current || '—'}
        </span>
      </div>

      <div className="relative">
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

      <div className="min-h-[24rem] flex-1">
        {loading ? (
          <div className="flex h-96 items-center justify-center text-muted-foreground">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : error ? (
          <div className="flex h-96 items-center justify-center px-4 text-center text-sm text-destructive">
            {error}
          </div>
        ) : (
          <ScrollArea className="h-96">
            <div className="py-1">
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
                  {search
                    ? t('project_folders.no_matching_folder')
                    : t('project_folders.empty_folder')}
                </p>
              )}
              {filteredEntries.map((e) => {
                const isDir = e.isDir !== false
                // In folder mode a file is context, not a target; an unreadable
                // file is shown disabled rather than hidden, so a wrong-permissions
                // mount is diagnosable from here.
                const selectable = isDir || (pickingFile && e.readable !== false)
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
