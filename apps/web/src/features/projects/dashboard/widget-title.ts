import { getPlugin } from '@/lib/plugins/registry'

/** With the title bar hidden, a plugin whose own title is left empty shows the widget's
 *  (localized) name instead, so hiding the bars never leaves a chart unnamed. Shared by
 *  the dashboard grid and the widget editor's preview, which must render alike. */
export function withFallbackTitleConfig(
  pluginId: string,
  config: Record<string, unknown>,
  title: string | undefined,
): Record<string, unknown> {
  if (!title) return config
  if (typeof config.title === 'string' && config.title.trim()) return config
  if (!getPlugin(pluginId)?.manifest.configSchema?.title) return config
  return { ...config, title }
}
