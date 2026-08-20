import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The three shapes a dialog takes in this app. Picking a kind — rather than a
 * width — is what keeps two dialogs of the same purpose looking identical.
 *
 * - `form`      create / add / edit / rename: one column of fields.
 * - `settings`  configuration, usually tabbed.
 * - `workbench` pickers, diffs, viewers: fixed height, body scrolls on its own.
 */
export type DialogKind = 'form' | 'settings' | 'workbench'

const KIND_CLASS: Record<DialogKind, string> = {
  form: 'sm:max-w-md',
  settings: 'sm:max-w-lg',
  workbench: 'flex h-[85vh] max-h-[85vh] flex-col sm:max-w-5xl',
}

/** Workbench bodies scroll internally so the header and footer stay put. */
const BODY_CLASS: Record<DialogKind, string> = {
  form: 'space-y-4 py-2',
  settings: 'space-y-4 py-2',
  workbench: 'min-h-0 flex-1 overflow-auto',
}

interface DialogShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind?: DialogKind
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  /**
   * Primary action. Omit for read-only dialogs (viewers, diffs) — the footer
   * then collapses to a single Close button, or disappears with `hideFooter`.
   */
  onConfirm?: () => void
  confirmLabel?: ReactNode
  confirmDisabled?: boolean
  /** Renders the primary button as destructive (delete, overwrite). */
  destructive?: boolean
  /** Spinner in the primary button; also blocks a second submit. */
  busy?: boolean
  cancelLabel?: ReactNode
  /** Extra footer content, placed before Cancel (e.g. a tertiary action). */
  footerExtra?: ReactNode
  hideFooter?: boolean
  /** Escape hatch for the rare dialog needing its own width or padding. */
  className?: string
  contentClassName?: string
}

/**
 * Shared dialog frame: width, header typography, body spacing and footer button
 * order all come from `kind`. Use this instead of assembling Dialog +
 * DialogContent + DialogHeader + DialogFooter by hand, so the app's dialogs
 * cannot drift apart one call site at a time.
 */
export function DialogShell({
  open,
  onOpenChange,
  kind = 'form',
  title,
  description,
  children,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  destructive,
  busy,
  cancelLabel,
  footerExtra,
  hideFooter,
  className,
  contentClassName,
}: DialogShellProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(KIND_CLASS[kind], className)}>
        <DialogHeader className={kind === 'workbench' ? 'shrink-0' : undefined}>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className={cn(BODY_CLASS[kind], contentClassName)}>{children}</div>

        {!hideFooter && (
          <DialogFooter className={kind === 'workbench' ? 'shrink-0' : undefined}>
            {footerExtra}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel ?? t(onConfirm ? 'common.cancel' : 'common.close')}
            </Button>
            {onConfirm && (
              <Button
                size="sm"
                variant={destructive ? 'destructive' : 'default'}
                onClick={onConfirm}
                disabled={confirmDisabled || busy}
                className="gap-1.5"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {confirmLabel ?? t('common.save')}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
