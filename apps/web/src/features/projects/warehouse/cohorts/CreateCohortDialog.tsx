import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { DialogShell } from '@/components/ui/dialog-shell'
import { DatabaseSelect } from '@/components/ui/database-select'
import { useSaveForm } from '@/hooks/use-save-form'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { buildPointer } from '@/lib/import-identity'
import type { DataSourceRef } from '@/types'

export interface CohortFormData {
  name: string
  description: string
  version: string
  dataSourceId?: string
  dataSourceRef?: DataSourceRef
}

interface CreateCohortDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CohortFormData) => void
  /** When set, the dialog edits this cohort's name/description instead of creating one.
   *  Its version is carried through untouched — a cohort belongs to a project and is
   *  not versioned on its own. */
  editing?: { name: string; description?: string; version?: string; dataSourceId?: string }
  workspaceId: string | undefined
  projectUid: string | undefined
}

export function CreateCohortDialog({
  open,
  onOpenChange,
  onSubmit,
  editing,
  workspaceId,
  projectUid,
}: CreateCohortDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!editing
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dataSourceId, setDataSourceId] = useState<string | undefined>()
  const databases = useDatabaseOptions(workspaceId, projectUid)

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setDescription(editing?.description ?? '')
      setDataSourceId(editing?.dataSourceId)
    }
  }, [open, editing])

  const handleSubmit = () => {
    if (!name.trim()) return
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      version: editing?.version ?? '0.1.0',
      dataSourceId,
      dataSourceRef: buildPointer(databases, dataSourceId),
    })
    onOpenChange(false)
  }

  // Wire Cmd/Ctrl+S → submit. The hook installs the shortcut listener itself; the
  // returned `save` is guarded (no-op unless dirty + valid), so nothing else to call.
  useSaveForm({
    current: { name: name.trim(), description: description.trim(), dataSourceId },
    baseline: {
      name: editing?.name ?? '',
      description: editing?.description ?? '',
      dataSourceId: editing?.dataSourceId,
    },
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
      <FormField label={t('cohorts.field_name')} required>
        {({ id }) => (
          <Input id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('cohorts.field_name_placeholder')}
            autoFocus
          />
        )}
      </FormField>

      <FormField label={t('cohorts.field_description')}>
        {({ id }) => (
          <Input id={id}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('cohorts.field_description_placeholder')}
          />
        )}
      </FormField>

      <FormField label={t('cohorts.field_database')}>
        {() => (
          <DatabaseSelect
            workspaceId={workspaceId}
            projectUid={projectUid}
            value={dataSourceId}
            onChange={setDataSourceId}
          />
        )}
      </FormField>
    </DialogShell>
  )
}
