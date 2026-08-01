import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, FolderUp, Loader2, RotateCcw, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fsListDir, type FsListing } from '@/lib/api/fs-browser'
import { formatApiError } from '@/lib/api-client'

interface Props {
  projectUid: string
  open: boolean
  /** Folder to open on first render (the current binding), else a browse root. */
  initialPath?: string
  /** The default folder for this binding; a "reset to default" button jumps the
   *  browser there (the user still confirms with "Select this folder"). */
  defaultPath?: string
  onClose: () => void
  onPick: (path: string) => void
}

/** A server-side folder picker: navigates the backend filesystem (dirs only) and
 * returns the chosen absolute path. Server mode only. */
export function ServerFolderPickerDialog({ projectUid, open, initialPath, defaultPath, onClose, onPick }: Props) {
  const { t } = useTranslation()
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      setSearch('')  // a fresh folder starts unfiltered
      try {
        setListing(await fsListDir(projectUid, path))
      } catch (e) {
        const fe = formatApiError(e)
        setError(fe.summary ?? fe.detail ?? String(e))
      } finally {
        setLoading(false)
      }
    },
    [projectUid],
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('project_folders.pick_folder')}</DialogTitle>
        </DialogHeader>

        <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground">
          <Folder size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={current}>{current || '—'}</span>
        </div>

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('project_folders.search_folders')}
            className="h-8 pl-8 text-sm"
          />
        </div>

        <div className="min-h-[24rem]">
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
                    {search ? t('project_folders.no_matching_folder') : t('project_folders.empty_folder')}
                  </p>
                )}
                {filteredEntries.map((e) => (
                  <button
                    key={e.path}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => load(e.path)}
                  >
                    <Folder size={15} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <ChevronRight size={14} className="shrink-0 text-muted-foreground/60" />
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {defaultPath ? (
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => load(defaultPath)}>
              <RotateCcw size={13} />
              {t('project_folders.reset_to_default')}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!current} onClick={() => onPick(current)}>
              {t('project_folders.select_this_folder')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
