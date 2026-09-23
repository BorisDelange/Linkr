import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { FieldError } from '@/components/ui/field-error'
import { DialogShell } from '@/components/ui/dialog-shell'
import { DatabaseSelect } from '@/components/ui/database-select'
import { useSaveForm } from '@/hooks/use-save-form'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { useUniqueName } from '@/hooks/use-unique-name'
import { localized, setLocalized } from '@/lib/localized'
import { buildPointer } from '@/lib/import-identity'
import { cn } from '@/lib/utils'
import { isProjectBoard, usePatientChartStore } from '@/stores/patient-chart-store'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
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
  const [dataSourceId, setDataSourceId] = useState(item.dataSourceId)
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const databases = useDatabaseOptions(workspaceId, item.projectUid)
  const allBoards = usePatientChartStore((s) => s.dashboards)
  const siblings = useMemo(
    () => allBoards.filter((d) => isProjectBoard(d, item.projectUid ?? '')),
    [allBoards, item.projectUid],
  )
  const { nameError, canSubmit } = useUniqueName({
    name,
    siblings,
    exceptId: item.id,
    errorKey: 'patient_data.board_name_exists',
  })

  const doSave = () => {
    updateDashboard(item.id, {
      name: setLocalized(item.name, language, name.trim()),
      description: setLocalized(item.description ?? {}, language, description.trim()),
      dataSourceId,
      dataSourceRef: buildPointer(databases, dataSourceId),
      version: initialVersion,
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name: name.trim(), description: description.trim(), dataSourceId },
    baseline: { name: initialName, description: initialDescription, dataSourceId: item.dataSourceId },
    onSave: doSave,
    canSave: canSubmit,
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
      dirtyTracked
      contentClassName="space-y-3 py-2"
    >
          <FormField label={t('common.name')} required>
            {({ id }) => (
              <>
                <Input id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={cn('h-8 text-sm', nameError && 'border-destructive')}
                  autoFocus
                />
                <FieldError message={nameError} />
              </>
            )}
          </FormField>
          <FormField label={t('common.description')}>
            {({ id }) => (
              <Input id={id}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="text-sm"
                placeholder={t('patient_data.board_description_placeholder')}
              />
            )}
          </FormField>
          <FormField label={t('patient_data.field_database')}>
            {() => (
              <DatabaseSelect
                workspaceId={workspaceId}
                projectUid={item.projectUid}
                value={dataSourceId}
                onChange={setDataSourceId}
                size="sm"
              />
            )}
          </FormField>
    </DialogShell>
  )
}
