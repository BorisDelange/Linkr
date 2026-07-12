import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { computeLineDiff } from '@/lib/line-diff'
import type { GitScope } from '@/lib/api/git'

interface GitDiffDialogProps {
  scope: GitScope
  id: string
  path: string
  branch: string
  onClose: () => void
}

/** Read-only unified diff of one export file (committed HEAD vs current export). */
export function GitDiffDialog({ scope, id, path, branch, onClose }: GitDiffDialogProps) {
  const { t } = useTranslation()
  const getDiff = useGitSyncStore((s) => s.getDiff)
  const [rows, setRows] = useState<ReturnType<typeof computeLineDiff> | null>(null)

  useEffect(() => {
    let cancelled = false
    void getDiff(scope, id, path, branch).then((d) => {
      if (cancelled) return
      setRows(computeLineDiff(d?.oldContent ?? '', d?.newContent ?? ''))
    })
    return () => {
      cancelled = true
    }
  }, [scope, id, path, branch, getDiff])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{path}</DialogTitle>
        </DialogHeader>
        {rows === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('versioning.sync_computing')}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{t('versioning.diff_empty')}</p>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <pre className="overflow-x-auto text-[11px] leading-relaxed">
              {rows.map((r, i) => (
                <div
                  key={i}
                  className={
                    r.type === 'add'
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : r.type === 'del'
                        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                        : 'text-muted-foreground'
                  }
                >
                  <span className="select-none pr-2 opacity-60">
                    {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}
                  </span>
                  {r.text || ' '}
                </div>
              ))}
            </pre>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
