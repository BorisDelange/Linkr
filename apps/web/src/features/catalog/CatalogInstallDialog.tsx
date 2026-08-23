import { useTranslation } from 'react-i18next'
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
import { GitErrorInline } from '@/components/versioning/GitErrorInline'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { localized } from '@/lib/localized'
import type { CatalogInstallState } from './use-catalog-install'

/**
 * The dialogs an install can raise.
 *
 * A *first* install asks nothing: the card carries the entry's name, version, author,
 * licence and target workspace, so a confirm step only restated what the user had just
 * read. Re-installing does ask — it replaces or duplicates a copy the user already has,
 * and which version replaces which is the decision being made. Beyond that:
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
  const {
    reinstall, conflict, failure,
    confirmReinstall, dismissReinstall, resolveConflict, dismissConflict, dismissFailure,
  } = install

  const unknown = t('catalog.version_unknown')

  return (
    <>
      <AlertDialog open={!!reinstall} onOpenChange={(open) => { if (!open) dismissReinstall() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reinstall?.outdated ? t('catalog.update') : t('catalog.reinstall_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reinstall ? localized(reinstall.entry.name, language) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {reinstall && (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="font-mono text-xs">
                {t('catalog.reinstall_versions', {
                  from: reinstall.localVersion ?? unknown,
                  to: reinstall.entry.version ?? unknown,
                })}
              </p>
              <p>
                {reinstall.outdated
                  ? t('catalog.update_available_hint')
                  : t('catalog.reinstall_same_version')}
              </p>
              <p>{t('catalog.update_choice_hint')}</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmReinstall()}>
              {reinstall?.outdated ? t('catalog.update') : t('catalog.reinstall')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
