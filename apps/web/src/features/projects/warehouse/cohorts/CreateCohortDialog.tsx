import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSaveForm } from '@/hooks/use-save-form'

interface CreateCohortDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { name: string; description: string }) => void
  /** When set, the dialog edits this cohort's name/description instead of creating one. */
  editing?: { name: string; description?: string }
}

export function CreateCohortDialog({ open, onOpenChange, onSubmit, editing }: CreateCohortDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!editing
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setDescription(editing?.description ?? '')
    }
  }, [open, editing])

  const handleSubmit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), description: description.trim() })
    onOpenChange(false)
  }

  // Wire Cmd/Ctrl+S → submit. The hook installs the shortcut listener itself; the
  // returned `save` is guarded (no-op unless dirty + valid), so nothing else to call.
  useSaveForm({
    current: { name: name.trim(), description: description.trim() },
    baseline: { name: editing?.name ?? '', description: editing?.description ?? '' },
    onSave: handleSubmit,
    canSave: name.trim().length > 0,
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('cohorts.edit_title') : t('cohorts.create_title')}</DialogTitle>
          <DialogDescription>{isEditing ? t('cohorts.edit_description') : t('cohorts.create_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t('cohorts.field_name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit() } }}
              placeholder={t('cohorts.field_name_placeholder')}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('cohorts.field_description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit() } }}
              placeholder={t('cohorts.field_description_placeholder')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim()}>
            {isEditing ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
