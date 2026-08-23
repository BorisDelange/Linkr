import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GitErrorInline } from '@/components/versioning/GitErrorInline'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { localized } from '@/lib/localized'
import type { CatalogInstallState } from './use-catalog-install'

/**
 * The dialogs an install can raise.
 *
 * A *first* install asks nothing: the card carries the entry's name, version, author,
 * licence and target workspace, so a confirm step only restated what the user had just
 * read. Re-installing does ask — it replaces or duplicates a copy the user already has.
 * That dialog puts the choice itself in the footer (overwrite or keep both) rather than
 * announcing that a second prompt is coming, so the decision takes one click.
 *
 * The separate conflict prompt still exists for the case this one cannot cover: the repo
 * id collides with a local entity the catalog did NOT recognise as its own, which is only
 * discoverable after the clone.
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
            <div className="space-y-3 text-sm text-muted-foreground">
              {/* Installed → catalog, as two badges: the pair IS the decision, so it
                  reads at a glance instead of as a sentence to parse. */}
              <div className="flex items-center gap-2">
                <span className="text-xs">{t('catalog.version_installed')}</span>
                <Badge variant="outline" className="font-mono">
                  v{reinstall.localVersion ?? unknown}
                </Badge>
                <ArrowRight size={14} className="shrink-0" />
                <span className="text-xs">{t('catalog.version_catalog')}</span>
                <Badge
                  variant="outline"
                  className={reinstall.outdated ? 'border-primary/40 bg-primary/5 font-mono text-primary' : 'font-mono'}
                >
                  v{reinstall.entry.version ?? unknown}
                </Badge>
              </div>
              <p>
                {reinstall.outdated
                  ? t('catalog.update_available_hint')
                  : t('catalog.reinstall_same_version')}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <Button variant="outline" onClick={() => void confirmReinstall(true)}>
              {t('common.import_duplicate')}
            </Button>
            <AlertDialogAction onClick={() => void confirmReinstall(false)}>
              {t('common.import_overwrite')}
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
