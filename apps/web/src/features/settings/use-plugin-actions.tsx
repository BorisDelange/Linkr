import { useCallback, useEffect, useState } from 'react'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { getStorage } from '@/lib/storage'
import { buildUserPluginZip } from '@/lib/entity-io'
import { PluginSettingsDialog } from './PluginSettingsDialog'
import type { LocalizedString, GitRemoteConfig, EntityLicense, UserPlugin } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

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
  docs: EntityDocsAccessors<PluginActionItem>
}

/**
 * Shared per-plugin actions (edit / export / versioning / delete) used by the app
 * header badge and the list cards so a plugin reads like every other entity.
 * Export/versioning open the shared Export & versioning dialog (via EntityActionsMenu).
 */
export function usePluginActions(): PluginActions {
  const deletePlugin = usePluginEditorStore((s) => s.deletePlugin)
  const refreshPluginList = usePluginEditorStore((s) => s.refreshPluginList)
  const pluginList = usePluginEditorStore((s) => s.pluginList)
  // PluginActionItem is deliberately minimal (the header badge builds one from the
  // open editor), so the docs come from storage rather than from the item.
  const [docsByPlugin, setDocsByPlugin] = useState<Record<string, Pick<UserPlugin, 'readme' | 'license'>>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await Promise.all(
        pluginList.filter((p) => !p.readOnly).map(async (p) => [p.id, await getStorage().userPlugins.getById(p.id)] as const),
      )
      if (cancelled) return
      setDocsByPlugin(Object.fromEntries(
        rows.filter(([, row]) => row).map(([id, row]) => [id, { readme: row!.readme, license: row!.license }]),
      ))
    })()
    return () => { cancelled = true }
  }, [pluginList])

  const saveDocs = useCallback(async (id: string, changes: Pick<UserPlugin, 'readme'> | { license?: EntityLicense }) => {
    await getStorage().userPlugins.update(id, changes)
    setDocsByPlugin((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }))
    await refreshPluginList()
  }, [refreshPluginList])

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
    docs: {
      getReadme: (item) => docsByPlugin[item.id]?.readme,
      onSaveReadme: (item, readme) => saveDocs(item.id, { readme }),
      getLicense: (item) => docsByPlugin[item.id]?.license ?? null,
      onSaveLicense: (item, license) => saveDocs(item.id, { license: license ?? undefined }),
      attachmentOwnerType: 'user-plugin',
    },
  }
}
