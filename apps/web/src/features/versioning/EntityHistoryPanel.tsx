import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, ChevronRight, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
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
import type { VersionedEntityType } from '@/stores/workspace-versioning-store'
import type { CommitFileChange, GitCommit } from '@/types'
import { DiffModal, formatRelativeTime, formatFullDateTime, fileChangeIcon } from './DiffModal'

// ---------------------------------------------------------------------------
// EntityCommitRow
// ---------------------------------------------------------------------------

interface EntityCommitRowProps {
  commit: GitCommit
  isFirst: boolean
  wsUid: string
  entityPathPrefix: string
  onRestore: (commit: GitCommit) => void
  onOpenDiff: (commit: GitCommit, file: CommitFileChange) => void
}

function EntityCommitRow({ commit, isFirst, wsUid, entityPathPrefix, onRestore, onOpenDiff }: EntityCommitRowProps) {
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
      const allFiles = await getCommitFiles(wsUid, commit.oid)
      // Filter to only files matching the entity path prefix
      const entityFiles = allFiles.filter(
        (f) => f.filepath === entityPathPrefix || f.filepath.startsWith(entityPathPrefix + '/')
      )
      setFiles(entityFiles)
      filesLoaded.current = true
      setLoadingFiles(false)
    }
  }, [expanded, wsUid, commit.oid, entityPathPrefix, getCommitFiles])

  return (
    <div className="group relative pb-6 last:pb-0">
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
// EntityHistoryPanel
// ---------------------------------------------------------------------------

export interface EntityHistoryPanelProps {
  workspaceId: string
  entityType: VersionedEntityType
  entityId: string
  entityName: string
  onRestored?: () => void
}

export function EntityHistoryPanel({ workspaceId, entityType, entityId, entityName, onRestored }: EntityHistoryPanelProps) {
  const { t } = useTranslation()
  const { getEntityCommits, restoreEntity, getFileDiff } = useWorkspaceVersioningStore()

  const [commits, setCommits] = useState<GitCommit[]>([])
  const [loading, setLoading] = useState(true)
  const [restoreTarget, setRestoreTarget] = useState<GitCommit | null>(null)
  const [restoring, setRestoring] = useState(false)

  // Diff modal state
  const [diffModal, setDiffModal] = useState<{ filepath: string; changeType: string; oldContent: string; newContent: string } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const entityPathPrefix = entityType === 'plugin'
    ? `plugins/${entityId}`
    : entityType === 'schema'
      ? `schemas/${entityId}.json`
      : `databases/${entityId}.json`

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getEntityCommits(workspaceId, entityType, entityId).then((result) => {
      if (!cancelled) {
        setCommits(result)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [workspaceId, entityType, entityId, getEntityCommits])

  const handleRestore = useCallback(async () => {
    if (!restoreTarget) return
    setRestoring(true)
    try {
      await restoreEntity(workspaceId, entityType, entityId, restoreTarget.oid)
      onRestored?.()
    } finally {
      setRestoring(false)
      setRestoreTarget(null)
    }
  }, [restoreTarget, workspaceId, entityType, entityId, restoreEntity, onRestored])

  const handleOpenDiff = useCallback(async (commit: GitCommit, file: CommitFileChange) => {
    setDiffModal({ filepath: file.filepath, changeType: file.changeType, oldContent: '', newContent: '' })
    setDiffLoading(true)
    const result = await getFileDiff(workspaceId, commit.oid, file.filepath)
    if (result) {
      setDiffModal({ filepath: file.filepath, changeType: result.changeType, oldContent: result.oldContent, newContent: result.newContent })
    }
    setDiffLoading(false)
  }, [workspaceId, getFileDiff])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        {t('app_versioning.loading_files')}
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="flex flex-col items-center py-12">
        <GitBranch size={36} className="text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium text-foreground">
          {t('app_versioning.no_entity_commits')}
        </p>
        <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
          {t('app_versioning.no_entity_commits_description')}
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="p-4">
        <div className="relative ml-3 border-l-2 border-orange-200 pl-6 dark:border-orange-800">
          {commits.map((commit, index) => (
            <EntityCommitRow
              key={commit.oid}
              commit={commit}
              isFirst={index === 0}
              wsUid={workspaceId}
              entityPathPrefix={entityPathPrefix}
              onRestore={setRestoreTarget}
              onOpenDiff={handleOpenDiff}
            />
          ))}
        </div>
      </div>

      {/* Restore confirmation */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('app_versioning.restore_entity_title', { entityType })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('app_versioning.restore_entity_description', {
                name: entityName,
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
