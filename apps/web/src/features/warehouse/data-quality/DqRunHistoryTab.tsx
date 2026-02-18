import { useTranslation } from 'react-i18next'
import { History, CheckCircle2, XCircle, Loader2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useDqStore } from '@/stores/dq-store'
import type { DqRunHistoryEntry } from '@/stores/dq-store'

interface Props {
  entries: DqRunHistoryEntry[]
}

const STATUS_STYLE: Record<DqRunHistoryEntry['status'], { icon: typeof CheckCircle2; color: string; label: string }> = {
  running: { icon: Loader2, color: 'text-blue-500', label: 'data_quality.rs_status_running' },
  success: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', label: 'data_quality.rs_status_success' },
  error: { icon: XCircle, color: 'text-red-600 dark:text-red-400', label: 'data_quality.rs_status_error' },
}

export function DqRunHistoryTab({ entries }: Props) {
  const { t } = useTranslation()
  const clearRunHistory = useDqStore((s) => s.clearRunHistory)

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <History size={32} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium text-foreground">{t('data_quality.no_history')}</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t('data_quality.no_history_description')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with clear button */}
      <div className="flex items-center justify-between border-b px-4 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t('data_quality.history_title')} ({entries.length})
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
          onClick={clearRunHistory}
        >
          <Trash2 size={12} />
          {t('data_quality.clear_history')}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-2xl space-y-2 p-4">
          {entries.map((entry) => {
            const cfg = STATUS_STYLE[entry.status]
            const StatusIcon = cfg.icon
            const scoreColor = (entry.score ?? 0) >= 95
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : (entry.score ?? 0) >= 80
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                : 'bg-red-500/15 text-red-700 dark:text-red-400'

            return (
              <div
                key={entry.id}
                className="flex items-center gap-3 rounded-lg border p-3 text-xs"
              >
                <StatusIcon
                  size={16}
                  className={cn(cfg.color, entry.status === 'running' && 'animate-spin')}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">
                      {new Date(entry.startedAt).toLocaleString()}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {t(cfg.label)}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span>
                      {t('data_quality.history_checks', { passed: entry.passed, total: entry.totalChecks - entry.notApplicable })}
                    </span>
                    {entry.durationMs != null && (
                      <span>
                        {t('data_quality.history_duration', { duration: (entry.durationMs / 1000).toFixed(1) })}
                      </span>
                    )}
                    {entry.failed > 0 && (
                      <span className="text-red-600 dark:text-red-400">
                        {entry.failed} failed
                      </span>
                    )}
                    {entry.errors > 0 && (
                      <span className="text-red-600 dark:text-red-400">
                        {entry.errors} errors
                      </span>
                    )}
                  </div>
                </div>

                {entry.score != null && (
                  <Badge variant="outline" className={cn('font-mono', scoreColor)}>
                    {entry.score}%
                  </Badge>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
