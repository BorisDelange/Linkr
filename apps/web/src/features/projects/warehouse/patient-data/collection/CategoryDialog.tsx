import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  cleanLocalized, localizedRaw, seedLocalizedForEditing, setLocalized,
} from '@/lib/localized'
import type { LocalizedString, PatientCollectionCategory } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The category being edited; absent when adding one. */
  category?: PatientCollectionCategory
  onSubmit: (category: PatientCollectionCategory) => void
}

/**
 * One dialog for adding and editing a form section.
 *
 * Name and description are multilingual and edited one language at a time, exactly
 * as a column's are — a section heading is read by the same people, in the same
 * languages, as the variables under it.
 */
export function CategoryDialog({ open, onOpenChange, category, onSubmit }: Props) {
  const { t, i18n } = useTranslation()
  const language = i18n.language

  const [name, setName] = useState<LocalizedString>({})
  const [description, setDescription] = useState<LocalizedString>({})

  useEffect(() => {
    if (!open) return
    setName(seedLocalizedForEditing(category?.name, language))
    setDescription(seedLocalizedForEditing(category?.description, language))
  }, [open, category, language])

  const valid = localizedRaw(name, language).trim() !== ''

  const submit = () => {
    if (!valid) return
    onSubmit({
      id: category?.id ?? crypto.randomUUID(),
      name: cleanLocalized(name) ?? {},
      description: cleanLocalized(description),
    })
    onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="form"
      title={category
        ? t('patient_data.collection_edit_category')
        : t('patient_data.collection_add_category')}
      onConfirm={submit}
      confirmLabel={category ? t('common.save') : t('common.add')}
      confirmDisabled={!valid}
    >
      <FormField label={t('common.name')} required>
        {({ id }) => (
          <Input
            id={id}
            value={localizedRaw(name, language)}
            onChange={(e) => setName(setLocalized(name, language, e.target.value))}
            autoFocus
          />
        )}
      </FormField>

      <FormField label={t('common.description')}>
        {({ id }) => (
          <Textarea
            id={id}
            value={localizedRaw(description, language)}
            onChange={(e) => setDescription(setLocalized(description, language, e.target.value))}
            rows={2}
          />
        )}
      </FormField>
    </DialogShell>
  )
}
