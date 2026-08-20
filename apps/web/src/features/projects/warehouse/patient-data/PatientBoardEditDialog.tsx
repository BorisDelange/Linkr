import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { DialogShell } from '@/components/ui/dialog-shell'
import { VersionField } from '@/components/ui/version-field'
import { useSaveForm } from '@/hooks/use-save-form'
import { localized, setLocalized } from '@/lib/localized'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useAppStore } from '@/stores/app-store'
import type { PatientDashboard } from '@/types'

export function PatientBoardEditDialog({
  item,
  onOpenChange,
}: {
  item: PatientDashboard
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)
  const initialName = localized(item.name, language)
  const initialDescription = item.description ? localized(item.description, language) : ''
  const initialVersion = item.version ?? '0.1.0'
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [version, setVersion] = useState(initialVersion)

  const doSave = () => {
    updateDashboard(item.id, {
      name: setLocalized(item.name, language, name.trim()),
      description: setLocalized(item.description ?? {}, language, description.trim()),
      version: version.trim() || '0.1.0',
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name: name.trim(), description: description.trim(), version: version.trim() },
    baseline: { name: initialName, description: initialDescription, version: initialVersion },
    onSave: doSave,
    canSave: name.trim().length > 0,
  })

  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t('patient_data.edit_board_title')}
      description={t('patient_data.edit_board_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSaveNow}
      contentClassName="space-y-3 py-2"
    >
          <div className="space-y-1">
            <Label>{t('common.name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label>{t('common.description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="text-sm"
              placeholder={t('patient_data.board_description_placeholder')}
            />
          </div>
          <VersionField value={version} onChange={setVersion} />
    </DialogShell>
  )
}
