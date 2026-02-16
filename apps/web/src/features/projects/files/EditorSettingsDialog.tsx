import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EditorSettingsForm } from '@/features/settings/EditorSettingsForm'

interface EditorSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EditorSettingsDialog({
  open,
  onOpenChange,
}: EditorSettingsDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('files.editor_settings')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('files.editor_settings')}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2">
          <EditorSettingsForm />
        </div>
      </DialogContent>
    </Dialog>
  )
}
