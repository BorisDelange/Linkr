import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { FieldError } from '@/components/ui/field-error'
import { DialogShell } from '@/components/ui/dialog-shell'
import { DatabaseSelect } from '@/components/ui/database-select'
import { useSaveForm } from '@/hooks/use-save-form'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { useUniqueName } from '@/hooks/use-unique-name'
import { buildPointer } from '@/lib/import-identity'
import { localizedRaw, seedLocalizedForEditing, setLocalized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { sameCohortOwner, useCohortStore } from '@/stores/cohort-store'
import type { DataSourceRef, LocalizedString } from '@/types'

export interface CohortFormData {
  name: LocalizedString
  description: LocalizedString
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
  editing?: {
    id: string
    name: LocalizedString
    description?: LocalizedString
    version?: string
    dataSourceId?: string
  }
  workspaceId: string | undefined
  projectUid: string | undefined
  /** A database's own cohort: it runs on that database, so there is no
   *  database to choose, and its name is unique among that database's cohorts. */
  ownerDataSourceId?: string
}

export function CreateCohortDialog({
  open,
  onOpenChange,
  onSubmit,
  editing,
  workspaceId,
  projectUid,
  ownerDataSourceId,
}: CreateCohortDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const isEditing = !!editing
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dataSourceId, setDataSourceId] = useState<string | undefined>()
  const databases = useDatabaseOptions(workspaceId, projectUid)
  const cohorts = useCohortStore((s) => s.cohorts)

  // Only the active language is shown and edited. Seeding from the other one
  // (rather than blank) keeps a cohort named in English from looking untitled
  // when the app is in French.
  useEffect(() => {
    if (open) {
      setName(localizedRaw(seedLocalizedForEditing(editing?.name, language), language))
      setDescription(
        localizedRaw(seedLocalizedForEditing(editing?.description, language), language),
      )
      setDataSourceId(editing?.dataSourceId)
    }
  }, [open, editing, language])

  // Two cohorts sharing a name also collide on export, where the filename is the
  // slug of the name — the disambiguation there is the safety net, this is the cause.
  const siblings = useMemo(
    () => cohorts.filter((c) => sameCohortOwner(c, { projectUid, ownerDataSourceId })),
    [cohorts, projectUid, ownerDataSourceId],
  )
  const { nameError, canSubmit } = useUniqueName({
    name,
    siblings,
    exceptId: editing?.id,
    errorKey: 'cohorts.name_exists',
  })

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit({
      // Merged into the existing map, so editing one language leaves the other
      // untouched instead of replacing the whole name.
      name: setLocalized(editing?.name, language, name.trim()),
      description: setLocalized(editing?.description, language, description.trim()),
      version: editing?.version ?? '0.1.0',
      ...(ownerDataSourceId
        ? {}
        : { dataSourceId, dataSourceRef: buildPointer(databases, dataSourceId) }),
    })
    onOpenChange(false)
  }

  // Wire Cmd/Ctrl+S → submit. The hook installs the shortcut listener itself; the
  // returned `save` is guarded (no-op unless dirty + valid), so nothing else to call.
  useSaveForm({
    current: { name: name.trim(), description: description.trim(), dataSourceId },
    baseline: {
      name: localizedRaw(seedLocalizedForEditing(editing?.name, language), language),
      description: localizedRaw(
        seedLocalizedForEditing(editing?.description, language),
        language,
      ),
      dataSourceId: editing?.dataSourceId,
    },
    onSave: handleSubmit,
    canSave: canSubmit,
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
      confirmDisabled={!canSubmit}
    >
      <FormField label={t('cohorts.field_name')} required>
        {({ id }) => (
          <>
            <Input id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('cohorts.field_name_placeholder')}
              className={cn(nameError && 'border-destructive')}
              autoFocus
            />
            <FieldError message={nameError} />
          </>
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

      {!ownerDataSourceId && (
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
      )}
    </DialogShell>
  )
}
