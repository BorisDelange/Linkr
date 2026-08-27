import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { EntityIdField } from '@/components/ui/entity-id-field'
import { DialogShell } from '@/components/ui/dialog-shell'
import { EntityDialogTabs } from '@/components/ui/entity-dialog-tabs'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { useAppStore } from '@/stores/app-store'
import { useSchemaPresetStore, buildSchemaPreset } from '@/stores/schema-preset-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { localized, setLocalized } from '@/lib/localized'
import type { CustomSchemaPreset, ProjectBadge } from '@/types'

/** Edits a schema preset's name, description, badges, version and attribution. */
export function SchemaPresetRenameDialog({ item, onOpenChange }: { item: CustomSchemaPreset; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const savePreset = useSchemaPresetStore((s) => s.savePreset)
  const presets = useSchemaPresetStore((s) => s.presets)
  const badgeCategories = useBadgeCategories()
  const initialName = localized(item.mapping.presetLabel, language)
  const initialDescription = item.mapping.description ? localized(item.mapping.description, language) : ''
  const initialBadges = item.badges ?? []
  const initialVersion = item.version ?? '0.1.0'
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [badges, setBadges] = useState<ProjectBadge[]>(initialBadges)
  const [version, setVersion] = useState(initialVersion)
  // Only the keys the user actually unlocked, so an untouched Attribution tab
  // leaves the original author and organization exactly as they were.
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  /** Badges already used by the other schemas, as the create dialog offers. */
  const badgeSuggestions = presets.flatMap((p) => p.badges ?? [])

  const doSave = async () => {
    const mapping = {
      ...item.mapping,
      presetLabel: setLocalized(item.mapping.presetLabel, language, name.trim()),
      description: setLocalized(item.mapping.description ?? {}, language, description.trim()),
    }
    await savePreset(
      buildSchemaPreset(item.entityId ?? item.id, mapping, item, item.workspaceId, { version, badges, authoring }),
    )
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    // Badges compare by value: the editor rebuilds the array on every change, so
    // a reference check would report the form dirty from the first render.
    current: {
      name: name.trim(),
      description: description.trim(),
      badges: JSON.stringify(badges),
      version,
      // Empty until the user unlocks a field, so re-attributing is what makes the
      // form dirty — matching how the other entity dialogs enable Save.
      authoring: JSON.stringify(authoring),
    },
    baseline: {
      name: initialName,
      description: initialDescription,
      badges: JSON.stringify(initialBadges),
      version: initialVersion,
      authoring: '{}',
    },
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
      dirtyTracked
    >
      <EntityDialogTabs
        generalIncomplete={!name.trim()}
        general={
          <>
            <div className="space-y-2">
              <Label>{t('schemas.field_name')}<RequiredMark /></Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <EntityIdField
              name={name}
              value={item.entityId ?? item.id}
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
          </>
        }
        metadata={
          <>
            <BadgeEditor
              categories={badgeCategories}
              value={badges}
              onChange={setBadges}
              suggestions={badgeSuggestions}
            />
            <VersionField value={version} onChange={setVersion} />
          </>
        }
        attribution={
          <AuthoringFields
            value={{
              createdById: 'createdById' in authoring ? authoring.createdById : item.createdById,
              createdBy: authoring.createdBy ?? item.createdBy,
              createdByDetails: authoring.createdByDetails ?? item.createdByDetails,
              organization: authoring.organization ?? item.organization,
            }}
            onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
          />
        }
      />
    </DialogShell>
  )
}
