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

/**
 * Workbench bodies scroll internally so the header and footer stay put.
 *
 * No vertical padding: `DialogContent` already spaces the body off the header
 * and footer, so adding `py-2` here only double-spaced it — which is why two
 * thirds of the call sites were cancelling it with `py-0`. A body that genuinely
 * wants the extra room asks for it.
 */
const BODY_CLASS: Record<DialogKind, string> = {
  form: 'space-y-4',
  settings: 'space-y-4',
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
  /**
   * Marks an edit form that tracks its own dirty state (see `useSaveForm`) and
   * disables the primary button when there is nothing to save. The secondary
   * button then reads "Close" rather than "Cancel": with no pending change,
   * there is nothing to cancel, and offering to would suggest there is.
   *
   * Not inferred from `confirmDisabled` alone — a create form is disabled until
   * it is filled in, and closing that one *is* cancelling.
   */
  dirtyTracked?: boolean
  /**
   * Extra footer content, placed before Cancel (e.g. a tertiary action).
   * Pinned to the far left, away from the primary pair — a discard action
   * shouldn't sit next to the button it undoes.
   */
  footerExtra?: ReactNode
  hideFooter?: boolean
  /**
   * Opt out of Enter-to-confirm, for a body where Enter means something else
   * (a code editor, a tag field that adds on Enter).
   */
  noEnterSubmit?: boolean
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
  dirtyTracked,
  footerExtra,
  hideFooter,
  noEnterSubmit,
  className,
  contentClassName,
}: DialogShellProps) {
  const { t } = useTranslation()

  /**
   * Enter confirms, the way it does in a native `<form>`. The shell renders no
   * `<form>`, so without this a dialog migrated onto it silently loses
   * Enter-to-submit — type a name in the autofocused field, press Enter, nothing
   * happens. Handled here rather than per call site, which had already drifted
   * into three different spellings across sibling dialogs.
   *
   * A textarea keeps Enter for newlines, and so does any element that opted out
   * via `data-no-enter-submit` (a tag field that adds on Enter, a combobox
   * choosing the highlighted option). A body that kept a real `<form>` owns
   * Enter through native submission, so the shell stays out of its way rather
   * than firing the handler a second time. Modifier chords are left alone too:
   * Ctrl/Cmd+Enter belongs to the body.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (noEnterSubmit || !onConfirm || confirmDisabled || busy) return
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    const el = e.target as HTMLElement | null
    if (el?.tagName === 'TEXTAREA') return
    if (el?.closest('[data-no-enter-submit], form')) return
    e.preventDefault()
    onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(KIND_CLASS[kind], className)} onKeyDown={handleKeyDown}>
        <DialogHeader className={kind === 'workbench' ? 'shrink-0' : undefined}>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className={cn(BODY_CLASS[kind], contentClassName)}>{children}</div>

        {!hideFooter && (
          <DialogFooter
            className={cn(
              kind === 'workbench' && 'shrink-0',
              footerExtra && 'sm:justify-between',
            )}
          >
            {footerExtra}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {cancelLabel ?? t(
                  // Nothing pending (read-only dialog, or a dirty-tracked form with no
                  // edits) → Close; otherwise the button really does cancel something.
                  !onConfirm || (dirtyTracked && confirmDisabled) ? 'common.close' : 'common.cancel',
                )}
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
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
