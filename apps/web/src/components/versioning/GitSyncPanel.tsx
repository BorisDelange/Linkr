import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCommitVertical, Loader2, RefreshCw, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useGitSyncStore } from '@/stores/git-sync-store'
import type { GitScope } from '@/lib/api/git'
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
  const { status, branches, selected, includeData, loadingStatus, committing, error, refreshStatus, loadBranches, commitPush, togglePath, setAllSelected, setIncludeData, reset } =
    useGitSyncStore()
  const [branch, setBranch] = useState(defaultBranch)
  const [message, setMessage] = useState('')
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [pushed, setPushed] = useState(false)

  useEffect(() => {
    void loadBranches(scope, id)
    void refreshStatus(scope, id, defaultBranch)
    return () => reset()
  }, [scope, id, defaultBranch, loadBranches, refreshStatus, reset])

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

      <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={includeData}
          onCheckedChange={(v) => setIncludeData(scope, id, !!v, branch)}
          disabled={loadingStatus || committing}
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
                <li key={f.path} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50">
                  <Checkbox
                    checked={selected.has(f.path)}
                    onCheckedChange={() => togglePath(f.path)}
                    className="shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => setDiffPath(f.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                  >
                    <ChangeBadge changeType={f.changeType} />
                    <span className="truncate font-mono">{f.path}</span>
                  </button>
                </li>
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
