import type { AnalysisPlugin } from '@/types/analysis-plugin'
import {
  installPythonPackage,
  listPythonPackages,
} from '@/lib/runtimes/pyodide-engine'
import {
  installRPackage,
  listRPackages,
} from '@/lib/runtimes/webr-engine'

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

/** Tracks which plugin+language combos have had their deps verified this session. */
const depsChecked = new Set<string>()

export function registerAnalysisPlugin(plugin: AnalysisPlugin) {
  plugins.set(plugin.manifest.id, plugin)
}

export function unregisterAnalysisPlugin(id: string) {
  plugins.delete(id)
}

export function getAnalysisPlugin(id: string): AnalysisPlugin | undefined {
  return plugins.get(id) ?? plugins.get(resolvePluginId(id))
}

export function getAllAnalysisPlugins(): AnalysisPlugin[] {
  return Array.from(plugins.values())
}

/** Return only plugins scoped to Lab (datasets/dashboards). */
export function getLabPlugins(): AnalysisPlugin[] {
  return Array.from(plugins.values()).filter(p => (p.manifest.scope ?? 'lab') === 'lab')
}

/** Return only plugins scoped to Warehouse (patient data). */
export function getWarehousePlugins(): AnalysisPlugin[] {
  return Array.from(plugins.values()).filter(p => p.manifest.scope === 'warehouse')
}

/** Maps a legacy short name (e.g. 'table1') to its full plugin id. */
export function resolvePluginId(typeOrId: string): string {
  return LEGACY_IDS[typeOrId] ?? typeOrId
}

/**
 * Ensure all declared dependencies for a plugin+language are installed.
 * Only checks once per session per plugin+language combo.
 * Returns the list of packages that were installed (empty if none needed).
 */
export async function ensurePluginDependencies(
  pluginId: string,
  language: 'python' | 'r',
  onLog?: (msg: string) => void,
): Promise<string[]> {
  const key = `${pluginId}:${language}`
  if (depsChecked.has(key)) return []

  const plugin = getAnalysisPlugin(pluginId)
  if (!plugin) return []

  const deps = plugin.manifest.dependencies?.[language]
  if (!deps || deps.length === 0) {
    depsChecked.add(key)
    return []
  }

  // List installed packages
  const installed = language === 'python'
    ? await listPythonPackages()
    : await listRPackages()
  const installedNames = new Set(installed.map(p => p.name.toLowerCase()))

  const missing = deps.filter(d => !installedNames.has(d.toLowerCase()))
  if (missing.length === 0) {
    depsChecked.add(key)
    return []
  }

  // Install missing packages
  const installedPkgs: string[] = []
  for (const pkg of missing) {
    onLog?.(`Installing ${pkg}...`)
    if (language === 'python') {
      await installPythonPackage(pkg, onLog)
    } else {
      await installRPackage(pkg, onLog)
    }
    installedPkgs.push(pkg)
  }

  depsChecked.add(key)
  return installedPkgs
}
