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
}

export function ImportConflictDialog({
  open,
  onOpenChange,
  existingName,
  onDuplicate,
  onOverwrite,
}: ImportConflictDialogProps) {
  const { t } = useTranslation()

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('common.import_conflict_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('common.import_conflict_description', { name: existingName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <Button variant="outline" onClick={() => { onOpenChange(false); onDuplicate() }}>
            {t('common.import_duplicate')}
          </Button>
          <Button onClick={() => { onOpenChange(false); onOverwrite() }}>
            {t('common.import_overwrite')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
