import type { Plugin } from '@/types/plugin'
import { isServerMode } from '@/lib/api-client'
import {
  installPythonPackage,
  listPythonPackages,
} from '@/lib/runtimes/pyodide-engine'
import {
  installRPackage,
  listRPackages,
} from '@/lib/runtimes/webr-engine'

/**
 * Module-level plugin registry, populated once at startup. A manifest id is unique
 * per workspace only, and a viewer loads the plugins of every workspace they can
 * read: a plugin resolves within the workspace of the project at hand, or to the
 * bundled built-in, never to another workspace's copy.
 */
const builtins = new Map<string, Plugin>()
const byWorkspace = new Map<string, Map<string, Plugin>>()

let currentWorkspace: () => string | null | undefined = () => null

/** Set by the stores, which this module cannot import. */
export function setPluginWorkspaceResolver(resolve: () => string | null | undefined) {
  currentWorkspace = resolve
}

/** Legacy type-name → plugin-id mapping. */
const LEGACY_IDS: Record<string, string> = {
  table1: 'linkr-analysis-table1',
  summary: 'linkr-analysis-summary',
}

/** Tracks which plugin+language combos have had their deps verified this session. */
const depsChecked = new Set<string>()

export function registerPlugin(plugin: Plugin) {
  const { workspaceId } = plugin
  if (!workspaceId) {
    builtins.set(plugin.manifest.id, plugin)
    return
  }
  let scoped = byWorkspace.get(workspaceId)
  if (!scoped) byWorkspace.set(workspaceId, (scoped = new Map()))
  scoped.set(plugin.manifest.id, plugin)
}

export function unregisterPlugin(id: string, workspaceId?: string | null) {
  if (workspaceId) byWorkspace.get(workspaceId)?.delete(id)
  else builtins.delete(id)
}

export function getPlugin(id: string, workspaceId: string | null | undefined = currentWorkspace()): Plugin | undefined {
  const scoped = workspaceId ? byWorkspace.get(workspaceId) : undefined
  const canonical = resolvePluginId(id)
  return scoped?.get(id) ?? builtins.get(id) ?? scoped?.get(canonical) ?? builtins.get(canonical)
}

/** The bundled built-in of that id, whatever a workspace holds under it. */
export function getBuiltinPlugin(id: string): Plugin | undefined {
  return builtins.get(id)
}

/** Every registration: built-ins, then each workspace's copies. An id may repeat. */
export function getAllPlugins(): Plugin[] {
  return [...builtins.values(), ...[...byWorkspace.values()].flatMap((scoped) => [...scoped.values()])]
}

/** What a workspace sees: the built-ins, with its own copies in their place. */
function visiblePlugins(workspaceId: string | null | undefined): Plugin[] {
  const scoped = workspaceId ? byWorkspace.get(workspaceId) : undefined
  return [...new Map([...builtins, ...(scoped ?? [])]).values()]
}

/** Return only plugins scoped to Lab (datasets/dashboards), as a workspace sees them. */
export function getLabPlugins(workspaceId: string | null | undefined = currentWorkspace()): Plugin[] {
  return visiblePlugins(workspaceId).filter((p) => (p.manifest.scope ?? 'lab') === 'lab')
}

/** Return only plugins scoped to Warehouse (patient data), as a workspace sees them. */
export function getWarehousePlugins(workspaceId: string | null | undefined = currentWorkspace()): Plugin[] {
  return visiblePlugins(workspaceId).filter((p) => p.manifest.scope === 'warehouse')
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
  // Server mode: packages are pre-provisioned in the server runtime image, and
  // the browser never installs them — checking/installing here would boot the
  // Pyodide/WebR WASM runtime for nothing.
  if (isServerMode()) return []

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
