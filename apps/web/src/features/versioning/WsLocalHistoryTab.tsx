import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import {
  GitBranch,
  ChevronRight,
  Search,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
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
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import type { CommitFileChange, GitCommit } from '@/types'
import { DiffModal, formatRelativeTime, formatFullDateTime, fileChangeIcon } from './DiffModal'

// ---------------------------------------------------------------------------
// Commit category detection
// ---------------------------------------------------------------------------

type CommitCategory = 'plugin' | 'wiki' | 'schema' | 'database' | 'other'

const CATEGORY_LABELS: Record<CommitCategory, string> = {
  plugin:   'plugins',
  wiki:     'wiki',
  schema:   'schemas',
  database: 'databases',
  other:    'other',
}

function detectCategory(message: string): CommitCategory {
  const lower = message.toLowerCase()
  if (lower.includes('plugin'))  return 'plugin'
  if (lower.includes('wiki'))    return 'wiki'
  if (lower.includes('schema'))  return 'schema'
  if (lower.includes('database') || lower.includes('data source')) return 'database'
  return 'other'
}

// ---------------------------------------------------------------------------
// Helpers (shared helpers imported from DiffModal.tsx)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CommitRow
// ---------------------------------------------------------------------------

interface CommitRowProps {
  commit: GitCommit
  isFirst: boolean
  wsUid: string
  category: CommitCategory
  onRestore: (commit: GitCommit) => void
  onOpenDiff: (commit: GitCommit, file: CommitFileChange) => void
}

function CommitRow({ commit, isFirst, wsUid, category: _category, onRestore, onOpenDiff }: CommitRowProps) {
  const { t } = useTranslation()
  const { getCommitFiles } = useWorkspaceVersioningStore()
  const [expanded, setExpanded] = useState(false)
  const [files, setFiles] = useState<CommitFileChange[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const filesLoaded = useRef(false)

  const toggleExpand = useCallback(async () => {
    const willExpand = !expanded
    setExpanded(willExpand)
    if (willExpand && !filesLoaded.current) {
      setLoadingFiles(true)
      const result = await getCommitFiles(wsUid, commit.oid)
      setFiles(result)
      filesLoaded.current = true
      setLoadingFiles(false)
    }
  }, [expanded, wsUid, commit.oid, getCommitFiles])

  return (
    <div className="group relative pb-6 last:pb-0">
      {/* Timeline dot */}
      <div className="absolute -left-[31px] top-1 h-2.5 w-2.5 rounded-full bg-orange-400 ring-4 ring-background" />

      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={toggleExpand}
          className="flex flex-1 items-start gap-2 text-left min-w-0"
        >
          <ChevronRight
            size={14}
            className={cn(
              'mt-1 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground">
                {commit.message}
              </p>
              {isFirst && (
                <span className="shrink-0 rounded-md border border-orange-300 px-1.5 py-0.5 text-[10px] font-medium text-orange-600 dark:border-orange-700 dark:text-orange-400">
                  {t('app_versioning.current')}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">{formatRelativeTime(commit.author.timestamp)}</span>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>
                  {formatFullDateTime(commit.author.timestamp)}
                </TooltipContent>
              </Tooltip>
              <span className="mx-1.5">&middot;</span>
              <span className="font-mono">{commit.oid.slice(0, 7)}</span>
            </p>
          </div>
        </button>

        {/* Restore button — hidden for the first (current) commit */}
        {!isFirst && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onRestore(commit)}
                className="mt-0.5 shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
              >
                <RotateCcw size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={4}>
              {t('app_versioning.restore_tooltip')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {expanded && (
        <div className="ml-5 mt-2">
          {loadingFiles ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 size={12} className="animate-spin" />
              {t('app_versioning.loading_files')}
            </div>
          ) : files && files.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground mb-1">
                {t('app_versioning.files_changed', { count: files.length })}
              </p>
              {files.map((f) => (
                <button
                  key={f.filepath}
                  type="button"
                  onClick={() => onOpenDiff(commit, f)}
                  className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50 w-full text-left"
                >
                  {fileChangeIcon(f.changeType)}
                  <span className="font-mono truncate">{f.filepath}</span>
                  <span className={cn(
                    'ml-auto shrink-0 text-[10px]',
                    f.changeType === 'added' && 'text-emerald-600 dark:text-emerald-400',
                    f.changeType === 'deleted' && 'text-red-600 dark:text-red-400',
                    f.changeType === 'modified' && 'text-amber-600 dark:text-amber-400',
                  )}>
                    {t(`app_versioning.file_${f.changeType}`)}
                  </span>
                </button>
              ))}
            </div>
          ) : files && files.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">
              {t('app_versioning.no_file_changes')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Category filter toggle buttons
// ---------------------------------------------------------------------------

const ALL_CATEGORIES: CommitCategory[] = ['plugin', 'wiki', 'schema', 'database', 'other']

function CategoryFilter({ active, onChange }: {
  active: Set<CommitCategory>
  onChange: (next: Set<CommitCategory>) => void
}) {
  const { t } = useTranslation()

  const toggle = (cat: CommitCategory) => {
    const next = new Set(active)
    if (next.has(cat)) {
      next.delete(cat)
    } else {
      next.add(cat)
    }
    onChange(next)
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {ALL_CATEGORIES.map((cat) => {
        const isActive = active.has(cat)
        return (
          <button
            key={cat}
            type="button"
            onClick={() => toggle(cat)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors border',
              isActive
                ? 'bg-foreground text-background border-foreground'
                : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-muted',
            )}
          >
            {t(`app_versioning.category_${CATEGORY_LABELS[cat]}`)}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WsLocalHistoryTab() {
  const { t } = useTranslation()
  const { wsUid } = useParams<{ wsUid: string }>()
  const { commits, hasMoreCommits, loadMoreCommits, restoreToCommit, loadCommits, getFileDiff } = useWorkspaceVersioningStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [activeCategories, setActiveCategories] = useState<Set<CommitCategory>>(() => new Set(ALL_CATEGORIES))
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<GitCommit | null>(null)
  const [restoring, setRestoring] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Diff modal state
  const [diffModal, setDiffModal] = useState<{ filepath: string; changeType: string; oldContent: string; newContent: string } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  // Set dateFrom to oldest commit date when commits first load
  useEffect(() => {
    if (commits.length > 0 && !dateFrom) {
      const oldest = commits[commits.length - 1]
      setDateFrom(new Date(oldest.author.timestamp * 1000).toISOString().slice(0, 10))
    }
  }, [commits, dateFrom])

  // Infinite scroll: observe sentinel element
  useEffect(() => {
    if (!wsUid || !hasMoreCommits) return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      async (entries) => {
        if (entries[0].isIntersecting && hasMoreCommits && !loadingMore) {
          setLoadingMore(true)
          await loadMoreCommits(wsUid)
          setLoadingMore(false)
        }
      },
      { threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [wsUid, hasMoreCommits, loadingMore, loadMoreCommits])

  const handleRestore = useCallback(async () => {
    if (!restoreTarget || !wsUid) return
    setRestoring(true)
    try {
      await restoreToCommit(wsUid, restoreTarget.oid)
    } finally {
      setRestoring(false)
      setRestoreTarget(null)
    }
  }, [restoreTarget, wsUid, restoreToCommit])

  const handleOpenDiff = useCallback(async (commit: GitCommit, file: CommitFileChange) => {
    if (!wsUid) return
    setDiffModal({ filepath: file.filepath, changeType: file.changeType, oldContent: '', newContent: '' })
    setDiffLoading(true)
    const result = await getFileDiff(wsUid, commit.oid, file.filepath)
    if (result) {
      setDiffModal({ filepath: file.filepath, changeType: result.changeType, oldContent: result.oldContent, newContent: result.newContent })
    }
    setDiffLoading(false)
  }, [wsUid, getFileDiff])

  // Memoize categories per commit
  const commitCategories = useMemo(() => {
    const map = new Map<string, CommitCategory>()
    for (const c of commits) {
      map.set(c.oid, detectCategory(c.message))
    }
    return map
  }, [commits])

  const filteredCommits = useMemo(() => {
    let filtered = commits
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter((c) => c.message.toLowerCase().includes(q))
    }
    if (dateFrom) {
      const fromTs = new Date(dateFrom).getTime() / 1000
      filtered = filtered.filter((c) => c.author.timestamp >= fromTs)
    }
    if (dateTo) {
      const toTs = new Date(dateTo + 'T23:59:59').getTime() / 1000
      filtered = filtered.filter((c) => c.author.timestamp <= toTs)
    }
    // Category filter
    if (activeCategories.size < ALL_CATEGORIES.length) {
      filtered = filtered.filter((c) => activeCategories.has(commitCategories.get(c.oid) ?? 'other'))
    }
    return filtered
  }, [commits, searchQuery, dateFrom, dateTo, activeCategories, commitCategories])

  if (!wsUid) return null

  return (
    <>
      {/* Filters — fixed height */}
      <Card className="shrink-0">
        <CardContent className="pt-4 space-y-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('app_versioning.search_placeholder')}
              className="pl-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground shrink-0">{t('app_versioning.date_from')}</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground shrink-0">{t('app_versioning.date_to')}</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
          </div>
          <CategoryFilter active={activeCategories} onChange={setActiveCategories} />
        </CardContent>
      </Card>

      {/* Commit timeline — fills remaining height, internal scroll */}
      <Card className="min-h-0 flex-1 flex flex-col">
        <CardContent className="min-h-0 flex-1 overflow-auto pt-4">
          {filteredCommits.length === 0 ? (
            <div className="flex flex-col items-center py-8">
              <GitBranch size={36} className="text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {commits.length === 0
                  ? t('app_versioning.no_commits')
                  : t('app_versioning.no_results')}
              </p>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {commits.length === 0
                  ? t('app_versioning.no_commits_description')
                  : t('app_versioning.no_results_description')}
              </p>
            </div>
          ) : (
            <div className="relative ml-3 border-l-2 border-orange-200 pl-6 dark:border-orange-800">
              {filteredCommits.map((commit, index) => (
                <CommitRow
                  key={commit.oid}
                  commit={commit}
                  isFirst={index === 0 && !searchQuery && !dateFrom}
                  wsUid={wsUid}
                  category={commitCategories.get(commit.oid) ?? 'other'}
                  onRestore={setRestoreTarget}
                  onOpenDiff={handleOpenDiff}
                />
              ))}

              {/* Infinite scroll sentinel */}
              {hasMoreCommits && (
                <div ref={sentinelRef} className="py-4 flex justify-center">
                  {loadingMore && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 size={14} className="animate-spin" />
                      {t('app_versioning.loading_more')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Restore confirmation dialog */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('app_versioning.restore_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('app_versioning.restore_description', {
                message: restoreTarget?.message ?? '',
                hash: restoreTarget?.oid.slice(0, 7) ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore} disabled={restoring}>
              {restoring ? (
                <Loader2 size={14} className="mr-2 animate-spin" />
              ) : (
                <RotateCcw size={14} className="mr-2" />
              )}
              {t('app_versioning.restore_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Diff modal */}
      <DiffModal
        open={!!diffModal}
        onClose={() => setDiffModal(null)}
        filepath={diffModal?.filepath ?? ''}
        oldContent={diffModal?.oldContent ?? ''}
        newContent={diffModal?.newContent ?? ''}
        changeType={diffModal?.changeType ?? 'modified'}
        loading={diffLoading}
      />
    </>
  )
}
