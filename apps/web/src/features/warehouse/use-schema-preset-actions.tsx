import { useCallback } from 'react'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { SchemaPresetRenameDialog } from './SchemaPresetRenameDialog'
import { localized } from '@/lib/localized'
import type { CustomSchemaPreset, GitRemoteConfig, LocalizedString, SchemaMapping } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

/** A CustomSchemaPreset adapted to EntityActionsMenu's `{ id, name }` contract. */
export type SchemaPresetItem = CustomSchemaPreset & { id: string; name: LocalizedString }

/** Wrap a preset with the id/name EntityActionsMenu expects (presetId / presetLabel). */
export function toSchemaPresetItem(preset: CustomSchemaPreset): SchemaPresetItem {
  return { ...preset, id: preset.presetId, name: preset.mapping.presetLabel }
}

export interface SchemaPresetActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: SchemaPresetItem) => void
  getGitRemote: (item: SchemaPresetItem) => GitRemoteConfig | null
  onSaveGitRemote: (item: SchemaPresetItem, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: SchemaPresetItem; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  docs: EntityDocsAccessors<SchemaPresetItem>
}

function downloadMapping(mapping: SchemaMapping) {
  const exportData = structuredClone(mapping)
  delete (exportData as { knownTables?: string[] }).knownTables
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const slug = localized(mapping.presetLabel, 'en').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase()
  a.download = `linkr-schema-${slug}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Shared per-item actions config for a schema preset (edit / export / git link /
 * delete). Used by both the list page cards and the header badge menu so the two
 * stay behaviourally identical.
 */
export function useSchemaPresetActions(): SchemaPresetActions {
  const deletePreset = useSchemaPresetStore((s) => s.deletePreset)
  const setGitRemote = useSchemaPresetStore((s) => s.setGitRemote)
  const updatePreset = useSchemaPresetStore((s) => s.updatePreset)

  const onSaveGitRemote = useCallback(async (item: SchemaPresetItem, config: GitRemoteConfig | null) => {
    await setGitRemote(item.presetId, config)
  }, [setGitRemote])

  return {
    onDelete: (id) => deletePreset(id),
    onExport: (item) => downloadMapping(item.mapping),
    getGitRemote: (item) => item.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <SchemaPresetRenameDialog item={item} onOpenChange={onOpenChange} />
    ),
    deleteConfirmTitleKey: 'settings.schema_preset_delete',
    deleteConfirmDescriptionKey: 'settings.schema_preset_delete_confirm',
    docs: {
      getReadme: (item) => item.readme,
      onSaveReadme: (item, readme) => updatePreset(item.presetId, { readme }),
      getLicense: (item) => item.license ?? null,
      onSaveLicense: (item, license) => updatePreset(item.presetId, { license: license ?? undefined }),
      attachmentOwnerType: 'schema-preset',
      getOwnerId: (item) => item.presetId,
      getWorkspaceId: (item) => item.workspaceId,
    },
  }
}
