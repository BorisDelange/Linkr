import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
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
import type { CardSelection } from '@/components/ui/use-card-selection'

interface BulkDeleteActionProps {
  selection: CardSelection
  /** Delete every selected key. Runs sequentially, in the grid's visible order. */
  onDeleteMany: (keys: string[]) => Promise<void>
  /** Names of the selected items, listed in the confirm dialog. */
  names: (key: string) => string
  /** When false, the delete button is disabled with a permission tooltip. */
  canDelete?: boolean
  /** Confirm title i18n key, receiving `{ count }`. */
  confirmTitleKey?: string
  /** Confirm description i18n key, receiving `{ count }`. */
  confirmDescriptionKey?: string
  /** Button/confirm label i18n key, receiving `{ count }`. Set it where the
   *  action isn't a delete — unlinking a database from a project, say. */
  actionLabelKey?: string
}

/**
 * Header actions for a card grid in multi-selection mode: a destructive
 * "Delete (N)" button plus a Clear button, replacing the page's Import/New
 * buttons for as long as something is selected. Pair it with `useCardSelection`
 * and render it INSTEAD of the normal header actions when `selection.active`.
 */
export function BulkDeleteAction({
  selection,
  onDeleteMany,
  names,
  canDelete = true,
  confirmTitleKey = 'common.bulk_delete_title',
  confirmDescriptionKey = 'common.bulk_delete_description',
  actionLabelKey = 'common.delete_count',
}: BulkDeleteActionProps) {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const keys = selection.orderedSelection().map(String)

  const handleDelete = async () => {
    setBusy(true)
    try {
      await onDeleteMany(keys)
      selection.clear()
      setConfirmOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={selection.clear}>
        <X size={14} />
        {t('common.clear_selection')}
      </Button>
      <GatedButton
        allowed={canDelete}
        notAllowedReason={t('common.insufficient_permissions')}
        variant="destructive"
        size="sm"
        className="gap-1 text-xs"
        onClick={() => setConfirmOpen(true)}
      >
        <Trash2 size={14} />
        {t(actionLabelKey, { count: selection.count })}
      </GatedButton>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(confirmTitleKey, { count: keys.length })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(confirmDescriptionKey, { count: keys.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-muted-foreground">
            {/* Truncation sits on the span: `overflow: hidden` on the <li> would
                clip the marker, which renders outside the item's box. */}
            {keys.map((key) => (
              <li key={key}><span className="block truncate">{names(key)}</span></li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void handleDelete() }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t(actionLabelKey, { count: keys.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Renders bulk actions when a selection is active, the page's own actions otherwise. */
export function CardGridHeaderActions({
  selection,
  bulk,
  children,
}: {
  selection: CardSelection
  bulk: ReactNode
  children: ReactNode
}) {
  return <>{selection.active ? bulk : children}</>
}
