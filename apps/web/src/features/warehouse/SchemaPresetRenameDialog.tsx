import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { EntityIdField } from '@/components/ui/entity-id-field'
import { DialogShell } from '@/components/ui/dialog-shell'
import { useAppStore } from '@/stores/app-store'
import { useSchemaPresetStore, buildSchemaPreset } from '@/stores/schema-preset-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { localized, setLocalized } from '@/lib/localized'
import type { CustomSchemaPreset } from '@/types'

/** Edits a schema preset's name + description in the active language. */
export function SchemaPresetRenameDialog({ item, onOpenChange }: { item: CustomSchemaPreset; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const savePreset = useSchemaPresetStore((s) => s.savePreset)
  const initialName = localized(item.mapping.presetLabel, language)
  const initialDescription = item.mapping.description ? localized(item.mapping.description, language) : ''
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)

  const doSave = async () => {
    const mapping = {
      ...item.mapping,
      presetLabel: setLocalized(item.mapping.presetLabel, language, name.trim()),
      description: setLocalized(item.mapping.description ?? {}, language, description.trim()),
    }
    await savePreset(buildSchemaPreset(item.presetId, mapping, item, item.workspaceId))
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name: name.trim(), description: description.trim() },
    baseline: { name: initialName, description: initialDescription },
    onSave: doSave,
    canSave: name.trim().length > 0,
  })

  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t('schemas.edit_title')}
      description={t('schemas.edit_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSaveNow}
    >
      <div className="space-y-2">
        <Label>{t('schemas.field_name')}<RequiredMark /></Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}
          autoFocus
        />
      </div>
      <EntityIdField
        name={name}
        value={item.presetId}
        onChange={() => {}}
        existingIds={[]}
        htmlId="schema-preset-id"
        readOnly
      />
      <div className="space-y-2">
        <Label>{t('schemas.field_description')}</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('schemas.field_description_placeholder')}
        />
      </div>
    </DialogShell>
  )
}
