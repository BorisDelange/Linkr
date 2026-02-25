import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import {
  GitBranch,
  GitCommitHorizontal,
  ChevronRight,
  Search,
  FilePlus,
  FileMinus,
  FileEdit,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
import type { Change } from 'diff'

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(timestamp * 1000).toLocaleDateString()
}

function formatFullDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function fileChangeIcon(type: string) {
  switch (type) {
    case 'added': return <FilePlus size={14} className="text-emerald-600 dark:text-emerald-400" />
    case 'deleted': return <FileMinus size={14} className="text-red-600 dark:text-red-400" />
    default: return <FileEdit size={14} className="text-amber-600 dark:text-amber-400" />
  }
}

function InlineDiffView({ changes }: { changes: Change[] }) {
  return (
    <div className="mt-2 rounded-md border bg-muted/20 overflow-x-auto text-xs font-mono">
      {changes.map((change, i) => {
        const lines = change.value.split('\n')
        if (lines[lines.length - 1] === '') lines.pop()

        return lines.map((line, j) => (
          <div
            key={`${i}-${j}`}
            className={cn(
              'px-3 py-0.5 whitespace-pre',
              change.added && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
              change.removed && 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300',
            )}
          >
            <span className="inline-block w-4 shrink-0 text-muted-foreground select-none">
              {change.added ? '+' : change.removed ? '-' : ' '}
            </span>
            {line}
          </div>
        ))
      })}
    </div>
  )
}

interface CommitRowProps {
  commit: GitCommit
  isFirst: boolean
  wsUid: string
  onRestore: (commit: GitCommit) => void
}

function CommitRow({ commit, isFirst, wsUid, onRestore }: CommitRowProps) {
  const { t } = useTranslation()
  const { getCommitFiles, getFileDiff } = useWorkspaceVersioningStore()
  const [expanded, setExpanded] = useState(false)
  const [files, setFiles] = useState<CommitFileChange[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const [fileDiffs, setFileDiffs] = useState<Record<string, Change[]>>({})
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null)
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

  const toggleFileDiff = useCallback(async (filepath: string) => {
    if (expandedFile === filepath) {
      setExpandedFile(null)
      return
    }
    setExpandedFile(filepath)
    if (!fileDiffs[filepath]) {
      setLoadingDiff(filepath)
      const result = await getFileDiff(wsUid, commit.oid, filepath)
      if (result) {
        setFileDiffs(prev => ({ ...prev, [filepath]: result.changes }))
      }
      setLoadingDiff(null)
    }
  }, [expandedFile, fileDiffs, wsUid, commit.oid, getFileDiff])

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
                <div key={f.filepath}>
                  <button
                    type="button"
                    onClick={() => toggleFileDiff(f.filepath)}
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
                  {expandedFile === f.filepath && (
                    loadingDiff === f.filepath ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 ml-2">
                        <Loader2 size={12} className="animate-spin" />
                        {t('app_versioning.loading_diff')}
                      </div>
                    ) : fileDiffs[f.filepath] ? (
                      <InlineDiffView changes={fileDiffs[f.filepath]} />
                    ) : null
                  )}
                </div>
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

export function WsLocalHistoryTab() {
  const { t } = useTranslation()
  const { wsUid } = useParams<{ wsUid: string }>()
  const { commits, hasMoreCommits, loadMoreCommits, restoreToCommit, loadCommits } = useWorkspaceVersioningStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<GitCommit | null>(null)
  const [restoring, setRestoring] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

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
    return filtered
  }, [commits, searchQuery, dateFrom, dateTo])

  if (!wsUid) return null

  return (
    <>
      {/* Filters */}
      <Card>
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
        </CardContent>
      </Card>

      {/* Commit timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('app_versioning.history_title')}</CardTitle>
        </CardHeader>
        <CardContent>
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
                  onRestore={setRestoreTarget}
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
    </>
  )
}
