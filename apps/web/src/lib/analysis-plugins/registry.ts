import type { AnalysisPlugin } from '@/types/analysis-plugin'

/** Module-level plugin registry. Populated once at startup. */
const plugins = new Map<string, AnalysisPlugin>()

/** Legacy type-name → plugin-id mapping. */
const LEGACY_IDS: Record<string, string> = {
  table1: 'linkr-analysis-table1',
  distribution: 'linkr-analysis-distribution',
  summary: 'linkr-analysis-summary',
  correlation: 'linkr-analysis-correlation',
  crosstab: 'linkr-analysis-crosstab',
}

export function registerAnalysisPlugin(plugin: AnalysisPlugin) {
  plugins.set(plugin.manifest.id, plugin)
}

export function getAnalysisPlugin(id: string): AnalysisPlugin | undefined {
  return plugins.get(id) ?? plugins.get(resolvePluginId(id))
}

export function getAllAnalysisPlugins(): AnalysisPlugin[] {
  return Array.from(plugins.values())
}

/** Maps a legacy short name (e.g. 'table1') to its full plugin id. */
export function resolvePluginId(typeOrId: string): string {
  return LEGACY_IDS[typeOrId] ?? typeOrId
}
