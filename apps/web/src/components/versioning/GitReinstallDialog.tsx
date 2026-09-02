import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
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

/**
 * Confirm rebuilding an entity's content from its repository.
 *
 * Spells out what goes rather than warning in the abstract: everything here is
 * replaced by what the repo holds, so anything never pushed is gone. The repo
 * and branch are shown because that is the one thing the user can still check
 * before committing to it.
 */
export function GitReinstallDialog({
  url,
  branch,
  busy,
  onConfirm,
  onClose,
}: {
  url: string
  branch: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('versioning.reinstall_confirm_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('versioning.reinstall_confirm_description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="min-w-0 rounded-md border bg-muted/40 px-3 py-2">
            <p className="min-w-0 break-all font-mono text-xs">{url}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{branch}</p>
          </div>

          <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-destructive" />
            <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
              {t('versioning.reinstall_confirm_warning')}
            </p>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            // Keep the dialog open while it runs: the work takes a clone plus a
            // full re-import, and closing first would leave the user with no sign
            // anything is happening.
            onClick={(e) => { e.preventDefault(); onConfirm() }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {busy ? t('versioning.reinstall_running') : t('versioning.reinstall_action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
