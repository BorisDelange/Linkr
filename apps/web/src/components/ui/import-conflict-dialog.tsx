import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface ImportConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingName: string
  onDuplicate: () => void
  onOverwrite: () => void
  /**
   * When the existing item lives in a different workspace than the current one, pass its
   * workspace name to explain *where* the conflict is (the user can't see it locally) and
   * warn that overwriting would move it out of that workspace.
   */
  existingWorkspaceName?: string
}

export function ImportConflictDialog({
  open,
  onOpenChange,
  existingName,
  onDuplicate,
  onOverwrite,
  existingWorkspaceName,
}: ImportConflictDialogProps) {
  const { t } = useTranslation()

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('common.import_conflict_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            {existingWorkspaceName ? (
              <div className="space-y-2">
                <p>{t('common.import_conflict_other_workspace_intro', { name: existingName, workspace: existingWorkspaceName })}</p>
                <ul className="space-y-1">
                  <li>
                    <span className="font-medium text-foreground">{t('common.import_duplicate')}</span>
                    {' — '}
                    {t('common.import_conflict_other_workspace_duplicate')}
                  </li>
                  <li>
                    <span className="font-medium text-foreground">{t('common.import_overwrite')}</span>
                    {' — '}
                    {t('common.import_conflict_other_workspace_overwrite', { workspace: existingWorkspaceName })}
                  </li>
                </ul>
              </div>
            ) : (
              <span>{t('common.import_conflict_description', { name: existingName })}</span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <Button onClick={() => { onOpenChange(false); onDuplicate() }}>
            {t('common.import_duplicate')}
          </Button>
          <Button variant="destructive" onClick={() => { onOpenChange(false); onOverwrite() }}>
            {t('common.import_overwrite')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
