import type { Plugin, PluginManifest } from '@/types/plugin'
import { registerPlugin } from './registry'
import { registerBuiltinWidgetPlugins } from './builtin-widget-plugins'
import { getStorage } from '@/lib/storage'

// --- Plugin manifests (JSON) ---
import table1Manifest from '@default-plugins/analyses/table1/plugin.json'
import distributionManifest from '@default-plugins/analyses/distribution/plugin.json'
import correlationManifest from '@default-plugins/analyses/correlation/plugin.json'
import crosstabManifest from '@default-plugins/analyses/crosstab/plugin.json'
// --- Code templates (raw strings) ---
import table1Py from '@default-plugins/analyses/table1/table1.py.template?raw'
import table1R from '@default-plugins/analyses/table1/table1.R.template?raw'
import distributionPy from '@default-plugins/analyses/distribution/distribution.py.template?raw'
import distributionR from '@default-plugins/analyses/distribution/distribution.R.template?raw'
import correlationPy from '@default-plugins/analyses/correlation/correlation.py.template?raw'
import correlationR from '@default-plugins/analyses/correlation/correlation.R.template?raw'
import crosstabPy from '@default-plugins/analyses/crosstab/crosstab.py.template?raw'
import crosstabR from '@default-plugins/analyses/crosstab/crosstab.R.template?raw'

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

export function registerDefaultPlugins() {
  // Lab plugins
  registerPlugin(
    buildPlugin(table1Manifest as unknown as Record<string, unknown>, { python: table1Py, r: table1R }),
  )
  registerPlugin(
    buildPlugin(distributionManifest as unknown as Record<string, unknown>, { python: distributionPy, r: distributionR }),
  )
  registerPlugin(
    buildPlugin(correlationManifest as unknown as Record<string, unknown>, { python: correlationPy, r: correlationR }),
  )
  registerPlugin(
    buildPlugin(crosstabManifest as unknown as Record<string, unknown>, { python: crosstabPy, r: crosstabR }),
  )

  // Warehouse system plugins (built-in patient data widgets)
  registerBuiltinWidgetPlugins()
}

/** Load user-created plugins from IndexedDB and register them. */
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
        registerPlugin(
          buildPlugin(rawManifest, Object.keys(templates).length > 0 ? templates : null),
        )
      } catch {
        // Skip plugins with invalid plugin.json
      }
    }
  } catch {
    // Storage may not be initialized yet — silently skip
  }
}
