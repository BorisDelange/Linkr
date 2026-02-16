import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { remarkPlugins, rehypePlugins, urlTransform } from './SummaryReadmeTab'
import { Button } from '@/components/ui/button'
import type { ReadmeSnapshot } from '@/types'

interface ReadmeHistoryPanelProps {
  history: ReadmeSnapshot[]
  currentReadme: string
  resolveAttachmentUrls: (md: string) => string
  onRestore: (snapshotId: string) => void
  onClose: () => void
}

export function ReadmeHistoryPanel({
  history,
  currentReadme,
  resolveAttachmentUrls,
  onRestore,
  onClose,
}: ReadmeHistoryPanelProps) {
  const { t } = useTranslation()

  // Build display list: snapshots reversed (newest first), plus mark current
  const snapshots = [...history].reverse()
  const [selectedId, setSelectedId] = useState<string | null>(
    snapshots[0]?.id ?? null,
  )

  const selectedSnapshot = snapshots.find((s) => s.id === selectedId)
  const isLatest = selectedId === snapshots[0]?.id
  const previewContent = selectedSnapshot?.content ?? ''

  if (snapshots.length === 0) {
    return (
      <div className="flex h-full flex-col pt-2">
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs text-muted-foreground"
            onClick={onClose}
          >
            <ArrowLeft size={12} />
            {t('summary.back_to_readme')}
          </Button>
        </div>
        <div className="mt-3 flex flex-1 items-center justify-center rounded-xl border bg-card shadow-xs">
          <p className="text-sm text-muted-foreground">
            {t('summary.no_history')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col pt-2">
      <div className="flex shrink-0 items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-2 text-xs text-muted-foreground"
          onClick={onClose}
        >
          <ArrowLeft size={12} />
          {t('summary.back_to_readme')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('summary.showing_versions', { count: snapshots.length })}
        </span>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-xs">
        {/* Left: snapshot list */}
        <div className="w-64 shrink-0 overflow-auto border-r">
          {snapshots.map((snapshot, index) => {
            const date = new Date(snapshot.savedAt)
            const isSelected = snapshot.id === selectedId
            const isCurrent = index === 0

            return (
              <button
                key={snapshot.id}
                type="button"
                onClick={() => setSelectedId(snapshot.id)}
                className={`flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors ${
                  isSelected
                    ? 'bg-accent'
                    : 'hover:bg-accent/50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isCurrent ? 'bg-primary' : 'bg-muted-foreground/40'
                    }`}
                  />
                  <span className="text-xs font-medium text-foreground">
                    {date.toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                    {', '}
                    {date.toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {isCurrent && (
                    <span className="ml-auto text-[10px] font-medium text-primary">
                      {t('summary.current')}
                    </span>
                  )}
                </div>
                <p className="truncate pl-3 text-[11px] text-muted-foreground">
                  {getSnapshotSummary(snapshot.content, index === 0 ? undefined : snapshots[index - 1]?.content)}
                </p>
              </button>
            )
          })}
        </div>

        {/* Right: preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto p-4">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
                {resolveAttachmentUrls(previewContent)}
              </ReactMarkdown>
            </div>
          </div>

          {/* Restore button (only for non-current, non-matching-current snapshots) */}
          {!isLatest && selectedSnapshot && selectedSnapshot.content !== currentReadme && (
            <div className="flex justify-end border-t px-4 py-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onRestore(selectedSnapshot.id)}
              >
                <RotateCcw size={12} />
                {t('summary.restore_version')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Generate a short summary by comparing with previous content. */
function getSnapshotSummary(
  content: string,
  _previousContent?: string,
): string {
  // Simple approach: first 60 chars of content
  const firstLine = content.split('\n').find((l) => l.trim()) ?? ''
  const cleaned = firstLine.replace(/^#+\s*/, '').trim()
  if (cleaned.length > 60) return cleaned.slice(0, 57) + '...'
  return cleaned || '(empty)'
}
