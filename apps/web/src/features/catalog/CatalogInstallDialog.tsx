import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { GitErrorInline } from '@/components/versioning/GitErrorInline'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { localized } from '@/lib/localized'
import type { CatalogInstallState } from './use-catalog-install'

/**
 * The two dialogs an install can still raise.
 *
 * Installing itself no longer asks anything: the card carries the entry's name,
 * version, author, licence and target workspace, so a confirm step only restated
 * what the user had just read. What remains are the cases that need an answer or
 * that a card has no room for:
 *   - a collision with an entity already installed → duplicate or overwrite,
 *   - a clone/write failure → the message plus its git detail.
 */
export function CatalogInstallOutcome({
  install,
  language,
}: {
  install: CatalogInstallState
  language: string
}) {
  const { t } = useTranslation()
  const { conflict, failure, resolveConflict, dismissConflict, dismissFailure } = install

  return (
    <>
      <ImportConflictDialog
        open={!!conflict}
        onOpenChange={(open) => { if (!open) dismissConflict() }}
        existingName={conflict?.existingName ?? ''}
        onDuplicate={() => void resolveConflict(true)}
        onOverwrite={() => void resolveConflict(false)}
      />

      <AlertDialog open={!!failure} onOpenChange={(open) => { if (!open) dismissFailure() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('catalog.install_failed')}</AlertDialogTitle>
            <AlertDialogDescription>
              {failure ? localized(failure.entry.name, language) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {failure && (
            <GitErrorInline message={t('catalog.install_failed')} detail={failure.detail} />
          )}
          <AlertDialogFooter>
            <AlertDialogAction>{t('common.close')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
