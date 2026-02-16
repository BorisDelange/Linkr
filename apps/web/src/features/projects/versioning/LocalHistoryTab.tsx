import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { GitBranch, GitCommitHorizontal, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useVersioningStore } from '@/stores/versioning-store'

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(timestamp * 1000).toLocaleDateString()
}

export function LocalHistoryTab() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const { commits, loading, fileChanges, createCommit, restoreCommit } = useVersioningStore()
  const [message, setMessage] = useState('')

  const hasChanges = fileChanges.modified > 0 || fileChanges.added > 0 || fileChanges.deleted > 0
  const canCommit = hasChanges && message.trim().length > 0 && !loading

  const handleCommit = async () => {
    if (!uid || !canCommit) return
    await createCommit(uid, message.trim())
    setMessage('')
  }

  return (
    <>
      {/* Commit zone */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.commit_title')}</CardTitle>
          <CardDescription>{t('versioning.commit_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('versioning.commit_placeholder')}
            rows={2}
            className="resize-none text-sm"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {fileChanges.modified > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  {fileChanges.modified} {t('versioning.status_modified')}
                </span>
              )}
              {fileChanges.added > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  {fileChanges.added} {t('versioning.status_added')}
                </span>
              )}
              {fileChanges.deleted > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                  {fileChanges.deleted} {t('versioning.status_deleted')}
                </span>
              )}
              {!hasChanges && (
                <span className="text-xs text-muted-foreground">
                  {t('versioning.no_changes')}
                </span>
              )}
            </div>
            <Button
              size="sm"
              onClick={handleCommit}
              disabled={!canCommit}
              className="gap-1.5"
            >
              <GitCommitHorizontal size={14} />
              {t('versioning.commit_button')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Commit timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.history_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {commits.length === 0 ? (
            <div className="flex flex-col items-center py-8">
              <GitBranch size={36} className="text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {t('versioning.no_commits')}
              </p>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {t('versioning.no_commits_description')}
              </p>
            </div>
          ) : (
            <div className="relative ml-3 border-l-2 border-orange-200 pl-6 dark:border-orange-800">
              {commits.map((commit, index) => (
                <div
                  key={commit.oid}
                  className="group relative pb-6 last:pb-0"
                >
                  {/* Timeline dot */}
                  <div className="absolute -left-[31px] top-1 h-2.5 w-2.5 rounded-full bg-orange-400 ring-4 ring-background" />

                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {commit.message}
                        </p>
                        {index === 0 && (
                          <span className="shrink-0 rounded-md border border-orange-300 px-1.5 py-0.5 text-[10px] font-medium text-orange-600 dark:border-orange-700 dark:text-orange-400">
                            {t('versioning.current')}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatRelativeTime(commit.author.timestamp)}
                        <span className="mx-1.5">·</span>
                        <span className="font-mono">{commit.oid.slice(0, 7)}</span>
                      </p>
                    </div>

                    {index > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => uid && restoreCommit(uid, commit.oid)}
                        disabled={loading}
                        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <RotateCcw size={14} />
                        <span className="ml-1">{t('versioning.restore')}</span>
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}
