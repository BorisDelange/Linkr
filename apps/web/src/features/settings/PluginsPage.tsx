import { PluginsTab } from './PluginsTab'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'

export function PluginsPage() {
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
      <div className="mx-auto max-w-4xl px-6 py-10">
        <PluginsTab />
      </div>
    </div>
  )
}
