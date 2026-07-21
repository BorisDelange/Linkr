import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, GitCommitVertical, Info, KeyRound, Loader2, RefreshCw, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { useAppStore } from '@/stores/app-store'
import { cn } from '@/lib/utils'
import { gitFileMeta, groupGitFiles } from '@/lib/git-file-meta'
import { buildQuickActions, isDataFilePath, type QuickAction } from '@/lib/git-quick-actions'
import { SYNC_ALL_ACCENT } from '@/lib/versioning-accent'
import { changeTypeMeta } from './git-change-meta'
import type { GitFileChange, GitScope } from '@/lib/api/git'
import { GitDiffDialog } from './GitDiffDialog'
import { PullResolveDialog } from './PullResolveDialog'
import { ChangeBadge } from './ChangeBadge'
import { GitErrorInline } from './GitErrorInline'

interface GitSyncPanelProps {
  scope: GitScope
  id: string
  /** The linked branch (config default), used until the user picks another. */
  defaultBranch: string
  /**
   * Custom pull UI for scopes with their own resolution flow (settings uses an
   * upsert dialog, not the mapping-project 3-way merge). When provided, the
   * behind/diverged banner opens THIS instead of the built-in PullResolveDialog,
   * and syncState (behind/diverged detection) is enabled for the scope. `onPulled`
   * refreshes the push status + sync anchor, exactly like the built-in flow.
   */
  renderPullDialog?: (args: { branch: string; onClose: () => void; onPulled: () => void | Promise<void> }) => ReactNode
}

/**
 * Push-only sync UI shown once an entity is linked to a git remote (server mode):
 * pick a branch, tick the files to include (data files unchecked by default),
 * review each file's diff in a full-size viewer, and commit + push the selection.
 */
export function GitSyncPanel({ scope, id, defaultBranch, renderPullDialog }: GitSyncPanelProps) {
  const { t } = useTranslation()
  const { status, branches, syncState, selected, includeData, loadingStatus, committing, error, refreshStatus, ensureStatus, loadBranches, loadSyncState, commitPush, commitPushPaths, togglePath, setAllSelected, setIncludeData, lfsPaths, toggleLfs } =
    useGitSyncStore()
  const authorName = useAppStore((s) => s.getUserDisplayName())
  // Behind/diverged detection is only wired for mapping projects in v1.
  // behind/diverged detection: mapping projects (built-in 3-way pull) and any scope
  // that supplies its own pull dialog (settings uses an upsert dialog).
  const syncStateSupported = scope === 'mapping-projects' || !!renderPullDialog
  const lfsSet = lfsPaths()
  const [branch, setBranch] = useState(defaultBranch)
  const [message, setMessage] = useState('')
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [pushed, setPushed] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  // Quick actions (simple, one-click) is the default; Details is the full
  // branch/file/message UI for advanced users.
  const [mode, setMode] = useState<'quick' | 'details'>('quick')

  // ensureStatus recomputes only when the entity/branch/includeData changed since
  // the last status (see the store), so switching tabs and returning to the same
  // mapping project reuses the computed status instead of recomputing from zero.
  // No reset on unmount — the store keeps the state; a different entity has a
  // different statusKey and recomputes on its own.
  useEffect(() => {
    void loadBranches(scope, id)
    void ensureStatus(scope, id, defaultBranch)
    if (syncStateSupported) void loadSyncState(scope, id, defaultBranch)
  }, [scope, id, defaultBranch, loadBranches, ensureStatus, loadSyncState, syncStateSupported])

  const changeBranch = (b: string) => {
    setBranch(b)
    void refreshStatus(scope, id, b)
    if (syncStateSupported) void loadSyncState(scope, id, b)
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
  // A private remote that couldn't be read (missing/invalid token) must NOT fall
  // through to the normal file view — the backend then sees an empty tree and
  // every file shows as "added", as if the repo were empty. Block both tabs with
  // a clear notice instead, pointing the user to add their token.
  const authBlocked = !loadingStatus && (error?.code === 'auth_failed' || error?.code === 'auth_required')
  const nothingToCommit = !loadingStatus && !authBlocked && files.length === 0
  const allChecked = files.length > 0 && files.every((f) => selected.has(f.path))
  // Block the push while the remote is ahead — pushing the local export would
  // fast-forward over the un-pulled remote work and drop it. The backend refuses
  // too (pull_required); this just disables the button up front.
  const mustPullFirst = !!syncState && (syncState.behind || syncState.diverged)

  // Quick actions commit + push a curated subset of the CHANGED files in one
  // click, with an auto-generated message — so a non-developer needn't tick
  // files and write a commit message for the common cases. Each action lists
  // the exact paths it will push (from the current changes) in a hover tooltip.
  const quickActions = buildQuickActions(scope, files)
  const runQuickAction = async (qa: QuickAction) => {
    if (committing || mustPullFirst || qa.files.length === 0) return
    // commitPushPaths refreshes the status once the push lands, so the cards
    // reflect the new remote state (the pushed files drop off) without a manual
    // refresh — during that recompute the tab shows the computing spinner, not
    // stale clickable buttons.
    const message = t(qa.messageKey, { author: authorName || t('versioning.quick_unknown_author') })
    const result = await commitPushPaths(scope, id, qa.files.map((f) => f.path), message, branch)
    if (result?.pushed) {
      setPushed(true)
      setTimeout(() => setPushed(false), 2000)
    }
  }

  const pullBanner = syncState && (syncState.behind || syncState.diverged) ? (
    <div
      className={
        syncState.diverged
          ? 'flex shrink-0 items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400'
          : 'flex shrink-0 items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-400'
      }
    >
      <ArrowDownToLine size={14} className="shrink-0" />
      <span className="flex-1">{t(syncState.diverged ? 'versioning.sync_diverged' : 'versioning.sync_behind')}</span>
      <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-xs" onClick={() => setPullOpen(true)}>
        <ArrowDownToLine size={12} />
        {t('versioning.pull_action')}
      </Button>
    </div>
  ) : null

  // Shown in place of the file view when the remote couldn't be read for auth
  // reasons — so the user adds a token rather than pushing over what looks like
  // an empty repo. Same amber treatment as the token badge in GitRepositoryTab.
  const authBlock = authBlocked ? (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
      <KeyRound size={15} className="mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">{t('versioning.sync_auth_blocked_title')}</p>
        <p className="leading-relaxed">{t('versioning.sync_auth_blocked_body')}</p>
      </div>
    </div>
  ) : null

  // Branch selector + Refresh, shared by both tabs so a Quick-actions user can
  // switch branch and refresh just like in Details (quick actions don't
  // auto-refresh after a push — the user refreshes here once the push lands).
  const branchRow = (
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
  )

  // Mapping projects have no optional data files (source-concepts always tracked,
  // scores always gitignored), so the toggle is a no-op there and stays hidden.
  const supportsDataFiles = scope !== 'mapping-projects'
  const includeDataToggle = supportsDataFiles ? (
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
  ) : null

  // Quick mode only exists for scopes that define quick actions (mapping
  // projects today). Elsewhere the panel is the Details UI alone, no tab bar.
  const hasQuickMode = quickActions.length > 0
  const effectiveMode = hasQuickMode ? mode : 'details'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Tabs value={effectiveMode} onValueChange={(v) => setMode(v as 'quick' | 'details')} className="flex min-h-0 flex-1 flex-col gap-3">
        {hasQuickMode && (
          <TabsList className="w-full">
            <TabsTrigger value="quick" className="flex-1 text-xs">{t('versioning.quick_tab')}</TabsTrigger>
            <TabsTrigger value="details" className="flex-1 text-xs">{t('versioning.details_tab')}</TabsTrigger>
          </TabsList>
        )}

        {/* Quick actions: one-click commit+push for a non-Git user. Branch +
            refresh like Details, but no file selection or commit message. */}
        <TabsContent value="quick" className="flex min-h-0 flex-1 flex-col gap-3">
          {branchRow}

          {/* Kept above the loading/empty states so it can be (un)ticked WHILE the
              status is still computing — toggling supersedes the in-flight compute
              and recomputes, so the user needn't wait for the first result. Hidden
              only when the remote can't be read (auth blocked). */}
          {!authBlocked && includeDataToggle}

          {loadingStatus ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              {t('versioning.sync_computing')}
            </div>
          ) : authBlocked ? (
            authBlock
          ) : nothingToCommit ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{t('versioning.sync_clean')}</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {quickActions.map((qa, i) => (
                  <QuickActionCard
                    key={qa.messageKey}
                    action={qa}
                    primary={i === 0}
                    committing={committing}
                    disabled={mustPullFirst}
                    includeData={includeData}
                    supportsDataFiles={supportsDataFiles}
                    onRun={() => runQuickAction(qa)}
                    t={t}
                  />
                ))}
              </div>
              {mustPullFirst && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <span>{t('versioning.quick_pull_required')}</span>
                </div>
              )}
              {pushed && (
                <span className="flex items-center gap-1 text-xs text-primary">
                  <GitCommitVertical size={13} />
                  {t('versioning.sync_pushed')}
                </span>
              )}
              {error && (
                <GitErrorInline detail={error.code === 'pull_required' ? t('versioning.sync_push_blocked') : error.raw} />
              )}
            </div>
          )}

          {pullBanner}
        </TabsContent>

        {/* Details: the full expert UI (branch select, refresh, file selection,
            per-file diff, custom commit message). */}
        <TabsContent value="details" className="flex min-h-0 flex-1 flex-col gap-3">
      {branchRow}

      {pullBanner}

      {authBlocked && authBlock}

      {!authBlocked && <>
      {includeDataToggle}

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
            <TooltipProvider delayDuration={200}>
              {groupGitFiles(scope, files, (f) => f.path).map((group) => (
                <div key={group.category}>
                  {/* Category header — helps a non-developer see what kind of
                      content each file is (General, Datasets, Dashboards, …). */}
                  <div className="sticky top-0 z-10 bg-muted/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                    {t(`versioning.file_cat_${group.category}`)}
                  </div>
                  <ul className="divide-y">
                    {group.files.map((f) => (
                      <GitFileRow
                        key={f.path}
                        scope={scope}
                        file={f}
                        checked={selected.has(f.path)}
                        isLfs={lfsSet.has(f.path)}
                        onToggleSelect={() => togglePath(f.path)}
                        onToggleLfs={() => toggleLfs(f.path)}
                        onOpenDiff={() => setDiffPath(f.path)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </TooltipProvider>
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
          <GitErrorInline detail={error.code === 'pull_required' ? t('versioning.sync_push_blocked') : error.raw} />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2">
        {pushed && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <GitCommitVertical size={13} />
            {t('versioning.sync_pushed')}
          </span>
        )}
        {mustPullFirst && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">{t('versioning.sync_pull_first')}</span>
        )}
        <Button
          onClick={handleCommit}
          disabled={!message.trim() || nothingToCommit || selected.size === 0 || committing || mustPullFirst}
          className="gap-1.5"
        >
          {committing ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
          {t('versioning.sync_commit_push')}
        </Button>
      </div>
      </>}
        </TabsContent>
      </Tabs>

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

      {pullOpen && renderPullDialog && renderPullDialog({
        branch,
        onClose: () => setPullOpen(false),
        onPulled: async () => {
          setPullOpen(false)
          await refreshStatus(scope, id, branch)
          await loadSyncState(scope, id, branch)
        },
      })}

      {pullOpen && !renderPullDialog && (
        <PullResolveDialog
          projectId={id}
          branch={branch}
          remoteHead={syncState?.remoteHead ?? null}
          onClose={() => setPullOpen(false)}
          onResolve={async (prepared, resolution) => {
            const { applyMappingProjectPull } = await import('@/lib/concept-mapping/pull')
            await applyMappingProjectPull(id, branch, prepared, resolution)
            setPullOpen(false)
            // The pull wrote to the DB, but the mapping-project views read from the
            // in-memory stores — reload them so the mappings table + summary/metadata
            // reflect the pulled changes without a manual page refresh. (Scores, if
            // taken, are already re-indexed inside applyMappingProjectPull.)
            const { useConceptMappingStore } = await import('@/stores/concept-mapping-store')
            const cm = useConceptMappingStore.getState()
            await cm.loadProjectMappings(id, { force: true })
            await cm.loadMappingProjects()
            // The DB changed and the anchor advanced → recompute the versioning view
            // against the fresh state (refreshStatus drops the cached export ZIP so
            // the pulled rows aren't re-shown as local changes to push).
            await refreshStatus(scope, id, branch)
            if (syncStateSupported) await loadSyncState(scope, id, branch)
          }}
        />
      )}
    </div>
  )
}

/**
 * A half-width "widget" for one quick action: a colored header (the shared accent
 * for the primary "Sync all", so it reads the same on every versioning page), the
 * exact files it will commit — each with an A/M/D change badge so a deletion is
 * unmistakable — and a commit+push button. When the action is "Sync all" and data
 * files aren't included, a warning flags that it will REMOVE the remote data files.
 * Disabled when there's nothing to push or a pull is required.
 */
function QuickActionCard({
  action, primary, committing, disabled, includeData, supportsDataFiles, onRun, t,
}: {
  action: QuickAction
  primary: boolean
  committing: boolean
  disabled: boolean
  includeData: boolean
  supportsDataFiles: boolean
  onRun: () => void
  t: (k: string) => string
}) {
  const nothing = action.files.length === 0
  const accent = action.isSyncAll
  // "Sync all" without data files pushes the DELETION of any data files the remote
  // still has — surface that so the user doesn't wipe them by accident.
  const deletesData =
    action.isSyncAll &&
    supportsDataFiles &&
    !includeData &&
    action.files.some((f) => f.changeType === 'deleted' && isDataFilePath(f.path))
  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm', accent && SYNC_ALL_ACCENT.border)}>
      <div className={cn('flex items-center gap-2 px-3 py-2', accent ? SYNC_ALL_ACCENT.headerBg : 'bg-muted/40')}>
        <UploadCloud size={14} className={cn('shrink-0', accent ? SYNC_ALL_ACCENT.icon : 'text-muted-foreground')} />
        <span className={cn('text-xs font-semibold', accent && SYNC_ALL_ACCENT.icon)}>{t(action.labelKey)}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t(action.descriptionKey)}</p>
        <div className="min-h-0 flex-1">
          {nothing ? (
            <p className="text-[11px] italic text-muted-foreground/70">{t('versioning.quick_nothing')}</p>
          ) : (
            <>
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{t('versioning.quick_will_push')}</p>
              <ul className="mt-1 space-y-0.5">
                {action.files.map((f) => {
                  const meta = changeTypeMeta(f.changeType)
                  return (
                    <li key={f.path} className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold', meta.badgeClass)}
                        title={t(meta.labelKey)}
                      >
                        {meta.letter}
                      </span>
                      <span className="block min-w-0 flex-1 truncate font-mono text-muted-foreground" title={f.path}>{f.path}</span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
        {deletesData && (
          <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{t('versioning.quick_deletes_data')}</span>
          </div>
        )}
        <Button
          size="sm"
          variant={primary ? 'default' : 'outline'}
          className="mt-1 h-8 w-full gap-1.5 text-xs"
          onClick={onRun}
          disabled={committing || disabled || nothing}
        >
          {committing ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
          {t(action.labelKey)}
        </Button>
      </div>
    </div>
  )
}

interface GitFileRowProps {
  scope: GitScope
  file: GitFileChange
  checked: boolean
  isLfs: boolean
  onToggleSelect: () => void
  onToggleLfs: () => void
  onOpenDiff: () => void
}

/** One row of the changes list: commit checkbox, change badge, path, an LFS chip
 *  (click to toggle), an info icon (hover = what the file is for), and a
 *  right-click menu to add/remove LFS tracking. */
function GitFileRow({ scope, file, checked, isLfs, onToggleSelect, onToggleLfs, onOpenDiff }: GitFileRowProps) {
  const { t } = useTranslation()
  const descriptionKey = gitFileMeta(scope, file.path).descriptionKey
  const description = descriptionKey ? t(descriptionKey) : null
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
          {description && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 cursor-help text-muted-foreground/60 hover:text-muted-foreground" aria-label={description}>
                  <Info size={12} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs text-xs">
                {description}
              </TooltipContent>
            </Tooltip>
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
