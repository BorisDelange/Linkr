import type { DashboardWidget, DashboardWidgetSource } from '@/types'
import { getPlugin } from '@/lib/plugins/registry'

/** The plugin's current declared version, or undefined when the plugin is unknown. */
function currentPluginVersion(pluginId: string): string | undefined {
  return getPlugin(pluginId)?.manifest.version
}

/**
 * True when a plugin widget was stamped with a version that differs from the plugin's
 * current declared version — i.e. the plugin author shipped a new version since the
 * widget was created/last edited. Neutral (false) whenever either version is absent,
 * so widgets created before this feature never raise a false warning.
 */
export function isWidgetPluginStale(widget: DashboardWidget): boolean {
  const { source } = widget
  if (source.type !== 'plugin') return false
  const stamped = source.pluginVersion
  if (!stamped) return false
  const current = currentPluginVersion(source.pluginId)
  if (!current) return false
  return stamped !== current
}

/**
 * Return a copy of the source stamped with the plugin's current version, realigning the
 * widget with the live plugin. No-op for non-plugin sources or unknown plugins. Used both
 * when creating/editing a widget and when the user explicitly accepts the new version.
 */
export function stampPluginVersion(source: DashboardWidgetSource): DashboardWidgetSource {
  if (source.type !== 'plugin') return source
  const current = currentPluginVersion(source.pluginId)
  if (!current) return source
  if (source.pluginVersion === current) return source
  return { ...source, pluginVersion: current }
}
