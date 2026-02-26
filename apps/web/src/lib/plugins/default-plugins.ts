import type { Plugin, PluginManifest } from '@/types/plugin'
import { registerPlugin } from './registry'
import { registerComponent } from './component-registry'
import { registerBuiltinWidgetPlugins } from './builtin-widget-plugins'
import { getStorage } from '@/lib/storage'
import { KeyIndicatorComponent } from '@/features/projects/lab/datasets/analyses/KeyIndicatorComponent'
import { PlotBuilderComponent } from '@/features/projects/lab/datasets/analyses/PlotBuilderComponent'

// --- Plugin manifests (JSON) ---
import table1Manifest from '@default-plugins/analyses/table1/plugin.json'
import plotBuilderManifest from '@default-plugins/analyses/plot-builder/plugin.json'
// --- Code templates (raw strings) ---
import table1Py from '@default-plugins/analyses/table1/table1.py.template?raw'
import table1R from '@default-plugins/analyses/table1/table1.R.template?raw'

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
  // Component-based lab plugins
  registerComponent('key-indicator', KeyIndicatorComponent)
  registerComponent('plot-builder', PlotBuilderComponent)
  registerPlugin({
    manifest: {
      id: 'linkr-analysis-key-indicator',
      name: { en: 'Key Indicator', fr: 'Indicateur clé' },
      description: {
        en: 'Display a single KPI with aggregate value, icon, and optional mini-chart.',
        fr: 'Affiche un indicateur clé avec valeur agrégée, icône et mini-graphique optionnel.',
      },
      version: '1.0.0',
      category: 'visualization',
      tags: ['kpi', 'indicator', 'dashboard'],
      runtime: ['component'],
      languages: [],
      icon: 'Gauge',
      iconColor: 'blue',
      configSchema: {
        column: {
          type: 'column-select',
          label: { en: 'Column', fr: 'Colonne' },
          filter: 'numeric',
          row: 'data',
        },
        aggregate: {
          type: 'select',
          label: { en: 'Aggregate function', fr: "Fonction d'agrégation" },
          default: 'mean',
          row: 'data',
          options: [
            { value: 'mean', label: { en: 'Mean', fr: 'Moyenne' } },
            { value: 'median', label: { en: 'Median', fr: 'Médiane' } },
            { value: 'min', label: { en: 'Min', fr: 'Min' } },
            { value: 'max', label: { en: 'Max', fr: 'Max' } },
            { value: 'sum', label: { en: 'Sum', fr: 'Somme' } },
            { value: 'count', label: { en: 'Count', fr: 'Effectif' } },
            { value: 'sd', label: { en: 'Std dev', fr: 'Écart-type' } },
            { value: 'q1', label: { en: 'Q1 (25th)', fr: 'Q1 (25e)' } },
            { value: 'q3', label: { en: 'Q3 (75th)', fr: 'Q3 (75e)' } },
            { value: 'iqr', label: { en: 'IQR', fr: 'IQR' } },
          ],
        },
        title: {
          type: 'string',
          label: { en: 'Title', fr: 'Titre' },
          default: '',
        },
        icon: {
          type: 'icon-select',
          label: { en: 'Icon', fr: 'Icône' },
          default: 'Activity',
          row: 'style',
        },
        color: {
          type: 'color-select',
          label: { en: 'Color', fr: 'Couleur' },
          default: 'blue',
          row: 'style',
        },
        chartType: {
          type: 'select',
          label: { en: 'Mini-chart', fr: 'Mini-graphique' },
          default: 'none',
          options: [
            { value: 'none', label: { en: 'None', fr: 'Aucun' } },
            { value: 'histogram', label: { en: 'Histogram', fr: 'Histogramme' } },
            { value: 'bar', label: { en: 'Bar chart', fr: 'Barres' } },
            { value: 'pie', label: { en: 'Pie chart', fr: 'Camembert' } },
          ],
        },
        chartBins: {
          type: 'number',
          label: { en: 'Histogram bins', fr: 'Nombre de barres' },
          default: 15,
          min: 5,
          max: 50,
          visibleWhen: { field: 'chartType', value: 'histogram' },
        },
      },
    },
    templates: null,
    componentId: 'key-indicator',
  })
  registerPlugin({
    manifest: normaliseManifest(plotBuilderManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'plot-builder',
  })

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
        const plugin = buildPlugin(rawManifest, Object.keys(templates).length > 0 ? templates : null)
        plugin.workspaceId = up.workspaceId
        registerPlugin(plugin)
      } catch {
        // Skip plugins with invalid plugin.json
      }
    }
  } catch {
    // Storage may not be initialized yet — silently skip
  }
}
