import type { Plugin } from '@/types/plugin'
import {
  installPythonPackage,
  listPythonPackages,
} from '@/lib/runtimes/pyodide-engine'
import {
  installRPackage,
  listRPackages,
} from '@/lib/runtimes/webr-engine'

/** Module-level plugin registry. Populated once at startup. */
const plugins = new Map<string, Plugin>()

/** Legacy type-name → plugin-id mapping. */
const LEGACY_IDS: Record<string, string> = {
  table1: 'linkr-analysis-table1',
  summary: 'linkr-analysis-summary',
}

/** Tracks which plugin+language combos have had their deps verified this session. */
const depsChecked = new Set<string>()

export function registerPlugin(plugin: Plugin) {
  plugins.set(plugin.manifest.id, plugin)
}

export function unregisterPlugin(id: string) {
  plugins.delete(id)
}

export function getPlugin(id: string): Plugin | undefined {
  return plugins.get(id) ?? plugins.get(resolvePluginId(id))
}

export function getAllPlugins(): Plugin[] {
  return Array.from(plugins.values())
}

/** Return only plugins scoped to Lab (datasets/dashboards).
 *  If workspaceId is provided, only include user plugins belonging to that workspace (built-ins always included). */
export function getLabPlugins(workspaceId?: string): Plugin[] {
  return Array.from(plugins.values()).filter(p => {
    if ((p.manifest.scope ?? 'lab') !== 'lab') return false
    if (workspaceId && p.workspaceId && p.workspaceId !== workspaceId) return false
    return true
  })
}

/** Return only plugins scoped to Warehouse (patient data).
 *  If workspaceId is provided, only include user plugins belonging to that workspace (built-ins always included). */
export function getWarehousePlugins(workspaceId?: string): Plugin[] {
  return Array.from(plugins.values()).filter(p => {
    if (p.manifest.scope !== 'warehouse') return false
    if (workspaceId && p.workspaceId && p.workspaceId !== workspaceId) return false
    return true
  })
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

  const plugin = getPlugin(pluginId)
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
