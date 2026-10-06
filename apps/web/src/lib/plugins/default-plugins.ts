import type { Plugin, PluginManifest } from '@/types/plugin'
import type { LocalizedString } from '@/types'
import { pluginFolder } from './plugin-readme'
import { registerPlugin, getPlugin, getAllPlugins } from './registry'
import { registerComponent } from './component-registry'
import { registerBuiltinWidgetPlugins, SYSTEM_PLUGIN_IDS } from './builtin-widget-plugins'
import { getStorage } from '@/lib/storage'
// Built-in viz components are NOT imported statically — they'd drag recharts,
// leaflet, vis-network, etc. into the initial bundle at registerDefaultPlugins()
// time. They're registered as lazy loaders (see registerComponent calls below)
// and their chunks load only when a component first renders.

// --- Plugin manifests (JSON) ---
import table1Manifest from '@default-plugins/analyses/table1/plugin.json'
import keyIndicatorManifest from '@default-plugins/analyses/key-indicator/plugin.json'
import plotBuilderManifest from '@default-plugins/analyses/plot-builder/plugin.json'
import mapManifest from '@default-plugins/analyses/map/plugin.json'
import statisticalTestsManifest from '@default-plugins/analyses/statistical-tests/plugin.json'
import regressionManifest from '@default-plugins/analyses/regression/plugin.json'
import kaplanMeierManifest from '@default-plugins/analyses/kaplan-meier/plugin.json'
import correlationMatrixManifest from '@default-plugins/analyses/correlation-matrix/plugin.json'
import sankeyManifest from '@default-plugins/analyses/sankey/plugin.json'
import surveyQuestionManifest from '@default-plugins/analyses/survey-question/plugin.json'
import spcManifest from '@default-plugins/analyses/spc/plugin.json'

// --- Plugin READMEs (markdown) ---
// A built-in's user documentation, bundled beside its manifest: `README.md` is
// English, `README.<lang>.md` a translation. Shown in the picker and in the
// widget editor's Doc tab, and seeded onto the workspace row so it exports with
// the plugin like any other entity's README.
//
// Globbed rather than imported one by one, so dropping a README beside a
// manifest is all it takes for that plugin to have documentation.
const readmeModules = import.meta.glob<string>('@default-plugins/*/*/README*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** READMEs by plugin FOLDER name. A plugin with no README shows no documentation. */
const READMES_BY_FOLDER: Record<string, LocalizedString> = {}
for (const [path, text] of Object.entries(readmeModules)) {
  const m = /\/([^/]+)\/README(?:\.([a-z]{2}))?\.md$/.exec(path)
  if (!m) continue
  const [, folder, lang] = m
  ;(READMES_BY_FOLDER[folder] ??= {})[lang ?? 'en'] = text
}

/** The bundled README for a manifest id, if one was shipped beside its manifest. */
function builtinReadme(manifestId: string): LocalizedString | undefined {
  return READMES_BY_FOLDER[pluginFolder(manifestId)]
}

/** Normalise a manifest from JSON (runtime may be string or array). */
function normaliseManifest(raw: Record<string, unknown>): PluginManifest {
  const m = raw as unknown as PluginManifest
  // Handle legacy `runtime: "script"` (string) → `["script"]`
  if (typeof (m as unknown as { runtime: unknown }).runtime === 'string') {
    m.runtime = [(m as unknown as { runtime: string }).runtime] as PluginManifest['runtime']
  }
  return m
}

export function buildPlugin(
  rawManifest: Record<string, unknown>,
  templates: Record<string, string> | null,
): Plugin {
  const manifest = normaliseManifest(rawManifest)
  return { manifest, templates }
}

// A Lab plugin is declared in three places that must agree: its manifest under
// packages/default-plugins/analyses/, the registerComponent + registerPlugin pair
// below, and — when it computes on the server — a kind in the backend's
// render/__init__.py _BUILDERS allow-list.
export function registerDefaultPlugins() {
  // Component-based lab plugins
  registerComponent('table1', () => import('@/features/projects/lab/datasets/analyses/Table1Component').then(m => ({ default: m.Table1Component })), { supportsServer: true })
  registerComponent('key-indicator', () => import('@/features/projects/lab/datasets/analyses/KeyIndicatorComponent').then(m => ({ default: m.KeyIndicatorComponent })), { supportsServer: true })
  registerComponent('plot-builder', () => import('@/features/projects/lab/datasets/analyses/PlotBuilderComponent').then(m => ({ default: m.PlotBuilderComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(table1Manifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'table1',
  })
  registerPlugin({
    manifest: normaliseManifest(keyIndicatorManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'key-indicator',
  })
  registerPlugin({
    manifest: normaliseManifest(plotBuilderManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'plot-builder',
  })
  registerComponent('survey-question', () => import('@/features/projects/lab/datasets/analyses/SurveyQuestionComponent').then(m => ({ default: m.SurveyQuestionComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(surveyQuestionManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'survey-question',
  })

  registerComponent('map', () => import('@/features/projects/lab/datasets/analyses/MapComponent').then(m => ({ default: m.MapComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(mapManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'map',
  })

  registerComponent('statistical-tests', () => import('@/features/projects/lab/datasets/analyses/StatisticalTestsComponent').then(m => ({ default: m.StatisticalTestsComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(statisticalTestsManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'statistical-tests',
  })

  registerComponent('regression', () => import('@/features/projects/lab/datasets/analyses/RegressionComponent').then(m => ({ default: m.RegressionComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(regressionManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'regression',
  })

  registerComponent('kaplan-meier', () => import('@/features/projects/lab/datasets/analyses/KaplanMeierComponent').then(m => ({ default: m.KaplanMeierComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(kaplanMeierManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'kaplan-meier',
  })

  registerComponent('correlation-matrix', () => import('@/features/projects/lab/datasets/analyses/CorrelationMatrixComponent').then(m => ({ default: m.CorrelationMatrixComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(correlationMatrixManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'correlation-matrix',
  })

  registerComponent('sankey', () => import('@/features/projects/lab/datasets/analyses/SankeyComponent').then(m => ({ default: m.SankeyComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(sankeyManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'sankey',
  })

  registerComponent('spc', () => import('@/features/projects/lab/datasets/analyses/SpcComponent').then(m => ({ default: m.SpcComponent })), { supportsServer: true })
  registerPlugin({
    manifest: normaliseManifest(spcManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'spc',
  })

  // Warehouse system plugins (built-in patient data widgets)
  registerBuiltinWidgetPlugins()

  // Attach the bundled READMEs once every built-in is registered, lab and
  // warehouse alike — and before the snapshot below, so the seeder carries them
  // onto each workspace's rows.
  for (const plugin of getAllPlugins()) {
    if (plugin.workspaceId) continue
    const readme = builtinReadme(plugin.manifest.id)
    if (readme) plugin.readme = readme
  }

  // Snapshot the canonical built-ins now, before any workspace-scoped user plugin
  // is registered on top (registerUserPlugins overwrites same-id entries with a
  // workspaceId set). The seeder must not rely on the mutable registry, otherwise
  // built-ins look "workspace-scoped" and stop being seeded from the 2nd workspace on.
  builtinSnapshot = getAllPlugins()
    .filter((p) => !p.workspaceId)
    .map((p) => ({ manifest: p.manifest, templates: p.templates, readme: p.readme }))
  builtinManifestIds = new Set(builtinSnapshot.map((p) => p.manifest.id))
}

/** Frozen list of built-in plugins captured at registration time (see above). */
let builtinSnapshot: {
  manifest: import('@/types/plugin').PluginManifest
  templates: Record<string, string> | null
  readme?: LocalizedString
}[] = []
/** Manifest ids of every app-provided built-in (lab components + warehouse widgets). */
let builtinManifestIds = new Set<string>()

/** True when a manifest id belongs to an app-provided built-in (read-only: its code
 *  lives in the bundle, not in editable files). Covers both lab and warehouse built-ins. */
export function isBuiltinPluginId(manifestId: string): boolean {
  return builtinManifestIds.has(manifestId)
}

/** Load user-created plugins from IndexedDB and register them. */
/**
 * Seed a copy of every built-in plugin as a workspace-scoped user_plugins row,
 * so each new workspace lists them in its Plugins page (mirrors the schema-preset
 * seed). Built-ins are compiled components with no editable code, so the row
 * carries only the manifest (+ templates when a built-in ever ships them); the
 * in-memory registry still supplies the runnable component. Idempotent: skips a
 * built-in already present in the workspace. Best-effort per plugin.
 */
export async function seedBuiltinPluginsForWorkspace(workspaceId: string): Promise<void> {
  const storage = getStorage()
  // Idempotence key is the MANIFEST id, not the row id. The row id must be unique
  // per workspace (it's a global primary key, both in IDB and the SQL backend —
  // String(36), i.e. a UUID), so we can't reuse manifest.id as the row id: the 2nd
  // workspace's seed would collide on the PK and silently fail. Track which manifest
  // ids are already seeded in this workspace via entityId (set to the manifest id).
  let seededManifestIds: Set<string>
  try {
    const existing = await storage.userPlugins.getByWorkspace(workspaceId)
    seededManifestIds = new Set(
      existing.map((p) => {
        if (p.entityId) return p.entityId
        try { return JSON.parse(p.files['plugin.json'] ?? '{}').id as string } catch { return p.id }
      }),
    )
  } catch {
    seededManifestIds = new Set()
  }
  // Iterate the frozen snapshot, not the live registry: once user plugins load,
  // built-ins in the registry gain a workspaceId and would be skipped otherwise.
  const builtins = builtinSnapshot.length > 0
    ? builtinSnapshot
    : getAllPlugins().filter((p) => !p.workspaceId).map((p) => ({ manifest: p.manifest, templates: p.templates, readme: p.readme }))
  const now = new Date().toISOString()
  for (const plugin of builtins) {
    if (seededManifestIds.has(plugin.manifest.id)) continue
    const files: Record<string, string> = {
      'plugin.json': JSON.stringify(plugin.manifest, null, 2),
    }
    if (plugin.templates) {
      for (const [lang, content] of Object.entries(plugin.templates)) {
        files[`analysis${lang === 'r' ? '.R.template' : '.py.template'}`] = content
      }
    }
    await storage.userPlugins
      .create({
        id: crypto.randomUUID(),
        entityId: plugin.manifest.id,
        files,
        readme: plugin.readme,
        createdAt: now,
        updatedAt: now,
        workspaceId,
      })
      .catch((e) => console.warn('[default-plugins] builtin seed:', plugin.manifest.id, e))
  }
}

export async function registerUserPlugins() {
  try {
    const storage = getStorage()
    const userPlugins = await storage.userPlugins.getAll()
    for (const up of userPlugins) {
      const manifestJson = up.files['plugin.json']
      if (!manifestJson) continue
      try {
        const rawManifest = JSON.parse(manifestJson) as Record<string, unknown>
        const templates: Record<string, string> = {}
        for (const [filename, content] of Object.entries(up.files)) {
          if (filename.endsWith('.py.template')) templates.python = content
          else if (filename.endsWith('.R.template')) templates.r = content
        }
        const plugin = buildPlugin(rawManifest, Object.keys(templates).length > 0 ? templates : null)
        plugin.workspaceId = up.workspaceId
        plugin.readme = up.readme
        // Don't overwrite built-in component plugins with IDB copies that lack componentId
        const existing = getPlugin(plugin.manifest.id)
        if (existing?.componentId && !plugin.componentId) continue
        // A built-in's manifest belongs to the BUNDLE, not to the workspace copy.
        //
        // The copy is a snapshot taken when the workspace was seeded and never
        // refreshed, so letting it win freezes the plugin at that version: a
        // renamed plugin keeps its old name, and — the reason this matters — a
        // config field added in a later release never appears, because the
        // panel is built from this manifest. Only the editable metadata a user
        // can legitimately change in their workspace is taken from the copy.
        if (existing && isBuiltinPluginId(plugin.manifest.id)) {
          plugin.manifest = existing.manifest
          plugin.componentId = plugin.componentId ?? existing.componentId
          // Same reasoning as the manifest: the bundled README is the current
          // one, the workspace copy a snapshot that never refreshes.
          plugin.readme = existing.readme ?? plugin.readme
        } else if (existing && SYSTEM_PLUGIN_IDS.has(plugin.manifest.id)) {
          // System widgets (e.g. timeline) own functional fields like configSchema
          // in code; persisted copies only carry editable metadata. Preserve the
          // built-in's schema so customising metadata can't drop the settings form.
          plugin.manifest.configSchema = existing.manifest.configSchema
          plugin.componentId = plugin.componentId ?? existing.componentId
        }
        registerPlugin(plugin)
      } catch {
        // Skip plugins with invalid plugin.json
      }
    }
  } catch {
    // Storage may not be initialized yet — silently skip
  }
}
