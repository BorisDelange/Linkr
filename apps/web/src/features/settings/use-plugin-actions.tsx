import { useCallback } from 'react'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { getStorage } from '@/lib/storage'
import { buildUserPluginZip } from '@/lib/entity-io'
import { PluginSettingsDialog } from './PluginSettingsDialog'
import type { LocalizedString, GitRemoteConfig } from '@/types'

/** Minimal entity shape the header badge / actions menu operates on. */
export interface PluginActionItem {
  id: string
  name: LocalizedString | string
  gitRemoteConfig?: GitRemoteConfig
}

export interface PluginActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: PluginActionItem) => void
  getGitRemote: (item: PluginActionItem) => GitRemoteConfig | null
  onSaveGitRemote: (item: PluginActionItem, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: PluginActionItem; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-plugin actions (edit / export / versioning / delete) used by the app
 * header badge and the list cards so a plugin reads like every other entity.
 * Export/versioning open the shared Export & versioning dialog (via EntityActionsMenu).
 */
export function usePluginActions(): PluginActions {
  const deletePlugin = usePluginEditorStore((s) => s.deletePlugin)
  const refreshPluginList = usePluginEditorStore((s) => s.refreshPluginList)

  const onExport = useCallback(async (item: PluginActionItem) => {
    // Use the canonical builder so the export carries the same author/org
    // provenance (in _plugin.json) and LFS handling as every other entity export.
    const result = await buildUserPluginZip(item.id, getStorage())
    if (!result) return
    const url = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.name}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const onSaveGitRemote = useCallback(async (item: PluginActionItem, config: GitRemoteConfig | null) => {
    await getStorage().userPlugins.update(item.id, { gitRemoteConfig: config ?? undefined })
    await refreshPluginList()
  }, [refreshPluginList])

  return {
    onDelete: (id) => deletePlugin(id),
    onExport,
    getGitRemote: (item) => item.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ onOpenChange }) => (
      <PluginSettingsDialog open mode="edit" onOpenChange={onOpenChange} />
    ),
    deleteConfirmTitleKey: 'plugins.delete',
    deleteConfirmDescriptionKey: 'plugins.delete_confirm',
  }
}
