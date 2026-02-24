import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, RotateCcw, GitCommitHorizontal } from 'lucide-react'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import type { WikiPage, GitCommit } from '@/types'

type HistoryEntry =
  | { type: 'snapshot'; id: string; timestamp: number; content: string }
  | { type: 'commit'; id: string; timestamp: number; commit: GitCommit }

interface WikiHistoryPanelProps {
  page: WikiPage
  workspaceId: string
  resolveAttachmentUrls: (md: string) => string
  onRestore: (snapshotId: string) => void
  onClose: () => void
}

export function WikiHistoryPanel({
  page,
  workspaceId,
  resolveAttachmentUrls,
  onRestore,
  onClose,
}: WikiHistoryPanelProps) {
  const { t } = useTranslation()
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string>('')
  const [loadingPreview, setLoadingPreview] = useState(false)

  // Load git commits for this page
  useEffect(() => {
    useWorkspaceVersioningStore.getState()
      .getFileCommits(workspaceId, page.id)
      .then(setGitCommits)
  }, [workspaceId, page.id])

  // Build merged timeline (git commits + legacy inline snapshots)
  const entries: HistoryEntry[] = [
    ...page.history.map((s) => ({
      type: 'snapshot' as const,
      id: s.id,
      timestamp: new Date(s.savedAt).getTime() / 1000,
      content: s.content,
    })),
    ...gitCommits.map((c) => ({
      type: 'commit' as const,
      id: c.oid,
      timestamp: c.author.timestamp,
      commit: c,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp)

  // Auto-select first entry
  useEffect(() => {
    if (entries.length > 0 && selectedId === null) {
      setSelectedId(entries[0].id)
    }
  }, [entries.length, selectedId])

  // Load preview content when selection changes
  useEffect(() => {
    const entry = entries.find((e) => e.id === selectedId)
    if (!entry) {
      setPreviewContent('')
      return
    }
    if (entry.type === 'snapshot') {
      setPreviewContent(entry.content)
    } else {
      setLoadingPreview(true)
      useWorkspaceVersioningStore.getState()
        .readFileAtCommit(workspaceId, entry.commit.oid, page.id)
        .then((content) => setPreviewContent(content ?? ''))
        .finally(() => setLoadingPreview(false))
    }
  }, [selectedId, workspaceId, page.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedEntry = entries.find((e) => e.id === selectedId)
  const isLatest = selectedId === entries[0]?.id
  const canRestore = !isLatest && selectedEntry && previewContent !== page.content

  const handleRestore = useCallback(async () => {
    if (!selectedEntry) return
    if (selectedEntry.type === 'snapshot') {
      onRestore(selectedEntry.id)
    } else {
      await useWorkspaceVersioningStore.getState()
        .restoreWikiPage(workspaceId, page.id, selectedEntry.commit.oid)
      onClose()
    }
  }, [selectedEntry, workspaceId, page.id, onRestore, onClose])

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={onClose}>
            <ArrowLeft size={12} /> {t('wiki.back_to_page')}
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('summary.no_history')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={onClose}>
          <ArrowLeft size={12} /> {t('wiki.back_to_page')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('summary.showing_versions', { count: entries.length })}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Entry list */}
        <div className="w-64 shrink-0 overflow-auto border-r">
          {entries.map((entry, index) => {
            const date = new Date(entry.timestamp * 1000)
            const isSelected = entry.id === selectedId
            const isCurrent = index === 0
            const isGit = entry.type === 'commit'

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedId(entry.id)}
                className={`flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors ${
                  isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {isGit ? (
                    <GitCommitHorizontal size={10} className="shrink-0 text-orange-400" />
                  ) : (
                    <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${isCurrent ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  )}
                  <span className="text-xs font-medium text-foreground">
                    {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {', '}
                    {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {isCurrent && (
                    <span className="ml-auto text-[10px] font-medium text-primary">{t('summary.current')}</span>
                  )}
                </div>
                <p className="truncate pl-3 text-[11px] text-muted-foreground">
                  {isGit
                    ? entry.commit.message
                    : getSnapshotSummary(entry.content)}
                </p>
                {isGit && (
                  <span className="pl-3 font-mono text-[10px] text-muted-foreground/60">
                    {entry.commit.oid.slice(0, 7)}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto p-4">
            {loadingPreview ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : (
              <MarkdownRenderer content={resolveAttachmentUrls(previewContent)} />
            )}
          </div>
          {canRestore && (
            <div className="flex justify-end border-t px-4 py-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleRestore}>
                <RotateCcw size={12} /> {t('summary.restore_version')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function getSnapshotSummary(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim()) ?? ''
  const cleaned = firstLine.replace(/^#+\s*/, '').trim()
  if (cleaned.length > 60) return cleaned.slice(0, 57) + '...'
  return cleaned || '(empty)'
}
