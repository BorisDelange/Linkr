import { useTranslation } from 'react-i18next'
import { PluginsTab } from './PluginsTab'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'

export function PluginsPage() {
  const { t } = useTranslation()
  const editingPluginId = usePluginEditorStore((s) => s.editingPluginId)

  // When editing a plugin, PluginsTab renders the full-screen editor — skip the page header
  if (editingPluginId) {
    return (
      <div className="h-full overflow-hidden">
        <PluginsTab />
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-6">
        <PluginsTab />
      </div>
    </div>
  )
}
