import { useCallback } from 'react'
import JSZip from 'jszip'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { getStorage } from '@/lib/storage'
import { localized } from '@/lib/localized'
import { slugify } from '@/lib/entity-io'
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
    const userPlugin = await getStorage().userPlugins.getById(item.id)
    if (!userPlugin) return
    const zip = new JSZip()
    for (const [filename, content] of Object.entries(userPlugin.files)) {
      zip.file(filename, content)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // Prefer the user-given Identifier (entityId), then a slug of the name, then the row id.
    let name = userPlugin.entityId
    if (!name) {
      try {
        const m = JSON.parse(userPlugin.files['plugin.json'] ?? '{}')
        name = slugify(localized(m.name, 'en')) || m.id
      } catch { /* fall through */ }
    }
    a.download = `${name || item.id}.zip`
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
