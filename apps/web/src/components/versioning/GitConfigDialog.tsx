import { useTranslation } from 'react-i18next'
import { ExternalLink, KeyRound, Link2Off, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { GitTokenHelp } from './GitTokenHelp'

interface GitConfigDialogProps {
  url: string
  /** Whether the current user has a token for this host; null while it loads. */
  hasToken: boolean | null
  saving: boolean
  onEditToken: () => void
  onDisconnect: () => void
  onClose: () => void
}

/**
 * Repository settings, out of the way.
 *
 * The URL, the token state and Disconnect used to occupy a permanent bar above
 * the sync panel, competing for space with the file list — for controls touched
 * once when linking the repo and then essentially never. They live here instead,
 * behind a button beside Refresh.
 */
export function GitConfigDialog({
  url, hasToken, saving, onEditToken, onDisconnect, onClose,
}: GitConfigDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* `grid-cols-[minmax(0,1fr)]` is what keeps the long repo URL inside the
          dialog: DialogContent is a grid, and a grid item's default
          `min-width: auto` lets that one unbroken token widen the track past the
          container, which `truncate` alone cannot undo. The min-w-0 below do the
          same for each nested flex child. */}
      <DialogContent className="w-[92vw] max-w-lg grid-cols-[minmax(0,1fr)] overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle>{t('versioning.config_title')}</DialogTitle>
          <DialogDescription>{t('versioning.config_description')}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="min-w-0 space-y-1.5">
            <Label>{t('versioning.remote_url')}</Label>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-start gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs hover:bg-muted"
              title={url}
            >
              {/* break-all rather than truncate: a repo URL is the one thing the
                  user may need to read in full here, and it has no spaces to wrap
                  on. Wrapping also makes the width fix independent of the grid
                  track — the text can never demand more than the container. */}
              <span className="min-w-0 flex-1 break-all font-mono">{url}</span>
              <ExternalLink size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
            </a>
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label>{t('versioning.remote_token')}</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                  hasToken
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                }`}
              >
                <KeyRound size={10} />
                {hasToken ? t('versioning.remote_token_set') : t('versioning.remote_no_token')}
              </span>
              <Button variant="outline" size="sm-tight" className="shrink-0" onClick={onEditToken} disabled={saving}>
                <KeyRound size={12} />
                {/* Until the status resolves, keep the neutral "Edit"; only assert
                    "Add" once we know there is no token. */}
                {hasToken === false ? t('versioning.remote_add_token') : t('versioning.remote_edit_token')}
              </Button>
            </div>
            {/* The help lists provider menu paths, which can be long — let it
                scroll rather than widen the dialog. */}
            <div className="max-h-48 min-w-0 overflow-y-auto rounded-md border bg-muted/30 p-2 text-muted-foreground">
              <GitTokenHelp />
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-3 py-2">
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
              {t('versioning.config_disconnect_hint')}
            </p>
            <Button
              variant="ghost"
              size="sm-tight"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={onDisconnect}
              disabled={saving}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Link2Off size={13} />}
              {t('versioning.remote_disconnect')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
