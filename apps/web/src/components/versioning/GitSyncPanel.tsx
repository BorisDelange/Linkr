import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCommitVertical, Loader2, RefreshCw, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useGitSyncStore } from '@/stores/git-sync-store'
import type { GitFileChange, GitScope } from '@/lib/api/git'
import { GitDiffDialog } from './GitDiffDialog'
import { ChangeBadge } from './ChangeBadge'
import { GitErrorInline } from './GitErrorInline'

interface GitSyncPanelProps {
  scope: GitScope
  id: string
  /** The linked branch (config default), used until the user picks another. */
  defaultBranch: string
}

/**
 * Push-only sync UI shown once an entity is linked to a git remote (server mode):
 * pick a branch, tick the files to include (data files unchecked by default),
 * review each file's diff in a full-size viewer, and commit + push the selection.
 */
export function GitSyncPanel({ scope, id, defaultBranch }: GitSyncPanelProps) {
  const { t } = useTranslation()
  const { status, branches, selected, includeData, loadingStatus, committing, error, refreshStatus, ensureStatus, loadBranches, commitPush, togglePath, setAllSelected, setIncludeData, lfsPaths, toggleLfs } =
    useGitSyncStore()
  const lfsSet = lfsPaths()
  const [branch, setBranch] = useState(defaultBranch)
  const [message, setMessage] = useState('')
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [pushed, setPushed] = useState(false)

  // ensureStatus recomputes only when the entity/branch/includeData changed since
  // the last status (see the store), so switching tabs and returning to the same
  // mapping project reuses the computed status instead of recomputing from zero.
  // No reset on unmount — the store keeps the state; a different entity has a
  // different statusKey and recomputes on its own.
  useEffect(() => {
    void loadBranches(scope, id)
    void ensureStatus(scope, id, defaultBranch)
  }, [scope, id, defaultBranch, loadBranches, ensureStatus])

  const changeBranch = (b: string) => {
    setBranch(b)
    void refreshStatus(scope, id, b)
  }

  const handleCommit = async () => {
    if (!message.trim() || committing || selected.size === 0) return
    const result = await commitPush(scope, id, message.trim(), branch)
    if (result?.pushed) {
      setPushed(true)
      setMessage('')
      setTimeout(() => setPushed(false), 2000)
    }
  }

  const files = status?.files ?? []
  const nothingToCommit = !loadingStatus && files.length === 0
  const allChecked = files.length > 0 && files.every((f) => selected.has(f.path))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs">{t('versioning.sync_branch')}</Label>
          <Select value={branch} onValueChange={changeBranch}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder={branch} />
            </SelectTrigger>
            <SelectContent>
              {(branches?.branches?.length ? branches.branches : [branch]).map((b) => (
                <SelectItem key={b} value={b} className="text-xs">
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => refreshStatus(scope, id, branch)}
          disabled={loadingStatus}
        >
          <RefreshCw size={13} className={loadingStatus ? 'animate-spin' : undefined} />
          {t('versioning.sync_refresh')}
        </Button>
      </div>

      <label htmlFor="git-include-data" className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          id="git-include-data"
          checked={includeData}
          onCheckedChange={(v) => setIncludeData(scope, id, !!v, branch)}
          // Not disabled during loading: toggling supersedes the in-flight
          // compute (statusGen) and recomputes immediately — no waiting.
          disabled={committing}
        />
        {t('versioning.sync_include_data')}
      </label>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            {!nothingToCommit && !loadingStatus && (
              <Checkbox
                checked={allChecked}
                onCheckedChange={(v) => setAllSelected(!!v)}
                aria-label={t('versioning.sync_select_all')}
              />
            )}
            <span className="text-xs font-medium">{t('versioning.sync_changes')}</span>
          </div>
          {status && (
            <span className="text-[11px] text-muted-foreground">
              {t('versioning.sync_summary', { added: status.added, modified: status.modified, deleted: status.deleted })}
            </span>
          )}
        </div>
        {loadingStatus ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('versioning.sync_computing')}
          </div>
        ) : nothingToCommit ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('versioning.sync_clean')}</p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="divide-y">
              {files.map((f) => (
                <GitFileRow
                  key={f.path}
                  file={f}
                  checked={selected.has(f.path)}
                  isLfs={lfsSet.has(f.path)}
                  onToggleSelect={() => togglePath(f.path)}
                  onToggleLfs={() => toggleLfs(f.path)}
                  onOpenDiff={() => setDiffPath(f.path)}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>

      {!nothingToCommit && (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          {t('versioning.sync_selected_count', { count: selected.size, total: files.length })}
        </p>
      )}

      <div className="shrink-0 space-y-2">
        <Label className="text-xs">{t('versioning.sync_message')}</Label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('versioning.sync_message_ph')}
          rows={2}
          className="text-sm"
          disabled={nothingToCommit}
        />
      </div>

      {error && (
        <div className="shrink-0">
          <GitErrorInline detail={error.raw} />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2">
        {pushed && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <GitCommitVertical size={13} />
            {t('versioning.sync_pushed')}
          </span>
        )}
        <Button
          onClick={handleCommit}
          disabled={!message.trim() || nothingToCommit || selected.size === 0 || committing}
          className="gap-1.5"
        >
          {committing ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
          {t('versioning.sync_commit_push')}
        </Button>
      </div>

      {diffPath && (
        <GitDiffDialog
          scope={scope}
          id={id}
          branch={branch}
          files={files}
          initialPath={diffPath}
          selected={selected}
          onToggle={togglePath}
          onClose={() => setDiffPath(null)}
        />
      )}
    </div>
  )
}

interface GitFileRowProps {
  file: GitFileChange
  checked: boolean
  isLfs: boolean
  onToggleSelect: () => void
  onToggleLfs: () => void
  onOpenDiff: () => void
}

/** One row of the changes list: commit checkbox, change badge, path, an LFS
 *  chip (click to toggle), and a right-click menu to add/remove LFS tracking. */
function GitFileRow({ file, checked, isLfs, onToggleSelect, onToggleLfs, onOpenDiff }: GitFileRowProps) {
  const { t } = useTranslation()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50">
          <Checkbox checked={checked} onCheckedChange={onToggleSelect} className="shrink-0" />
          <button
            type="button"
            onClick={onOpenDiff}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
          >
            <ChangeBadge changeType={file.changeType} />
            <span className="truncate font-mono">{file.path}</span>
          </button>
          {isLfs && (
            <button
              type="button"
              onClick={onToggleLfs}
              title={t('versioning.lfs_remove')}
              className="shrink-0 rounded-sm bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-violet-600 hover:bg-violet-500/25 dark:text-violet-400"
            >
              LFS
            </button>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onToggleLfs}>
          {isLfs ? t('versioning.lfs_remove') : t('versioning.lfs_add')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
