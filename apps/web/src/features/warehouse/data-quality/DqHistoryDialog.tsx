import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { History, CheckCircle2, XCircle, Loader2, Trash2, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { cn } from '@/lib/utils'
import { useDqStore, type DqRunHistoryEntry } from '@/stores/dq-store'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** History is scoped to this rule set. */
  ruleSetId: string
  /** Reopen a past run's report in the results table. */
  onRestore: (entry: DqRunHistoryEntry) => void
}

const STATUS_STYLE: Record<DqRunHistoryEntry['status'], { icon: typeof CheckCircle2; color: string; label: string }> = {
  running: { icon: Loader2, color: 'text-blue-500', label: 'data_quality.rs_status_running' },
  success: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', label: 'data_quality.rs_status_success' },
  error: { icon: XCircle, color: 'text-red-600 dark:text-red-400', label: 'data_quality.rs_status_error' },
}

export function DqHistoryDialog({ open, onOpenChange, ruleSetId, onRestore }: Props) {
  const { t } = useTranslation()
  const runHistory = useDqStore((s) => s.runHistory)
  const clearRunHistory = useDqStore((s) => s.clearRunHistory)
  const deleteRunHistory = useDqStore((s) => s.deleteRunHistory)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const entries = runHistory.filter((e) => e.ruleSetId === ruleSetId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={16} />
            {t('data_quality.history_title')}
            {entries.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto mr-6 h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 size={12} />
                {t('data_quality.clear_history')}
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>

        {entries.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <History size={32} className="text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium text-foreground">{t('data_quality.no_history')}</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t('data_quality.no_history_description')}</p>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2 pr-3">
              {entries.map((entry) => {
                const cfg = STATUS_STYLE[entry.status]
                const StatusIcon = cfg.icon
                return (
                  <div key={entry.id} className="flex items-center gap-3 rounded-lg border p-3 text-xs">
                    <StatusIcon size={16} className={cn(cfg.color, entry.status === 'running' && 'animate-spin')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{new Date(entry.startedAt).toLocaleString()}</span>
                        <Badge variant="outline" className="text-[10px]">{t(cfg.label)}</Badge>
                        {entry.score != null && (
                          <span className="text-[10px] text-muted-foreground">{entry.score}%</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>{t('data_quality.history_checks', { passed: entry.passed, total: entry.totalChecks - entry.notApplicable })}</span>
                        {entry.durationMs != null && (
                          <span>{t('data_quality.history_duration', { duration: (entry.durationMs / 1000).toFixed(1) })}</span>
                        )}
                        {entry.failed > 0 && <span className="text-red-600 dark:text-red-400">{t('data_quality.history_failed', { count: entry.failed })}</span>}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1 text-[11px]"
                      disabled={!entry.report}
                      onClick={() => { onRestore(entry); onOpenChange(false) }}
                    >
                      <RotateCcw size={12} />
                      {t('data_quality.history_view')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      title={t('common.delete')}
                      onClick={() => setDeleteId(entry.id)}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('data_quality.clear_history_confirm_title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('data_quality.clear_history_confirm_body')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => { void clearRunHistory(ruleSetId); setConfirmOpen(false) }}
              >
                {t('data_quality.clear_history')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={deleteId !== null} onOpenChange={(o) => { if (!o) setDeleteId(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('data_quality.delete_run_confirm_title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('data_quality.delete_run_confirm_body')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => { if (deleteId) void deleteRunHistory(deleteId); setDeleteId(null) }}
              >
                {t('common.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
