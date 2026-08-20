import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { DialogShell } from '@/components/ui/dialog-shell'
import { useSaveForm } from '@/hooks/use-save-form'
import { VersionField } from '@/components/ui/version-field'

interface CreateCohortDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { name: string; description: string; version: string }) => void
  /** When set, the dialog edits this cohort's name/description/version instead of creating one. */
  editing?: { name: string; description?: string; version?: string }
}

export function CreateCohortDialog({ open, onOpenChange, onSubmit, editing }: CreateCohortDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!editing
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('0.1.0')

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setDescription(editing?.description ?? '')
      setVersion(editing?.version ?? '0.1.0')
    }
  }, [open, editing])

  const handleSubmit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), description: description.trim(), version: version.trim() || '0.1.0' })
    onOpenChange(false)
  }

  // Wire Cmd/Ctrl+S → submit. The hook installs the shortcut listener itself; the
  // returned `save` is guarded (no-op unless dirty + valid), so nothing else to call.
  useSaveForm({
    current: { name: name.trim(), description: description.trim(), version: version.trim() },
    baseline: { name: editing?.name ?? '', description: editing?.description ?? '', version: editing?.version ?? '0.1.0' },
    onSave: handleSubmit,
    canSave: name.trim().length > 0,
    enabled: open,
  })

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? t('cohorts.edit_title') : t('cohorts.create_title')}
      description={isEditing ? t('cohorts.edit_description') : t('cohorts.create_description')}
      onConfirm={handleSubmit}
      confirmLabel={isEditing ? t('common.save') : t('common.create')}
      confirmDisabled={!name.trim()}
    >
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

      <VersionField value={version} onChange={setVersion} />
    </DialogShell>
  )
}
