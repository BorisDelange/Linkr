import type { Plugin, PluginManifest } from '@/types/plugin'
import { registerPlugin, getPlugin } from './registry'
import { registerComponent } from './component-registry'
import { registerBuiltinWidgetPlugins } from './builtin-widget-plugins'
import { getStorage } from '@/lib/storage'
import { KeyIndicatorComponent } from '@/features/projects/lab/datasets/analyses/KeyIndicatorComponent'
import { PlotBuilderComponent } from '@/features/projects/lab/datasets/analyses/PlotBuilderComponent'
import { Table1Component } from '@/features/projects/lab/datasets/analyses/Table1Component'
import { StatisticalTestsComponent } from '@/features/projects/lab/datasets/analyses/StatisticalTestsComponent'
import { RegressionComponent } from '@/features/projects/lab/datasets/analyses/RegressionComponent'
import { KaplanMeierComponent } from '@/features/projects/lab/datasets/analyses/KaplanMeierComponent'
import { CorrelationMatrixComponent } from '@/features/projects/lab/datasets/analyses/CorrelationMatrixComponent'

// --- Plugin manifests (JSON) ---
import table1Manifest from '@default-plugins/analyses/table1/plugin.json'
import plotBuilderManifest from '@default-plugins/analyses/plot-builder/plugin.json'
import statisticalTestsManifest from '@default-plugins/analyses/statistical-tests/plugin.json'
import regressionManifest from '@default-plugins/analyses/regression/plugin.json'
import kaplanMeierManifest from '@default-plugins/analyses/kaplan-meier/plugin.json'
import correlationMatrixManifest from '@default-plugins/analyses/correlation-matrix/plugin.json'

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
  // Component-based lab plugins
  registerComponent('table1', Table1Component)
  registerComponent('key-indicator', KeyIndicatorComponent)
  registerComponent('plot-builder', PlotBuilderComponent)
  registerPlugin({
    manifest: normaliseManifest(table1Manifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'table1',
  })
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
        // --- Appearance ---
        title: {
          type: 'string',
          label: { en: 'Title', fr: 'Titre' },
          default: '',
          row: 'title',
          section: { en: 'Appearance', fr: 'Apparence' },
        },
        centerTitle: {
          type: 'boolean',
          label: { en: 'Center', fr: 'Centrer' },
          default: false,
          row: 'title',
          section: { en: 'Appearance', fr: 'Apparence' },
        },
        icon: {
          type: 'icon-select',
          label: { en: 'Icon', fr: 'Icône' },
          default: 'Activity',
          row: 'appearance',
          section: { en: 'Appearance', fr: 'Apparence' },
        },
        color: {
          type: 'color-select',
          label: { en: 'Color', fr: 'Couleur' },
          default: 'blue',
          row: 'appearance',
          section: { en: 'Appearance', fr: 'Apparence' },
        },
        // --- Data ---
        column: {
          type: 'column-select',
          label: { en: 'Column', fr: 'Colonne' },
          row: 'columnStat',
          section: { en: 'Data', fr: 'Données' },
          autoSet: {
            numeric: { aggregate: 'mean', unit: '', targetValue: '' },
            categorical: { aggregate: 'proportion', unit: '%', targetValue: '' },
          },
        },
        aggregate: {
          type: 'select',
          label: { en: 'Statistic', fr: 'Statistique' },
          default: 'mean',
          row: 'columnStat',
          section: { en: 'Data', fr: 'Données' },
          filterOptionsByColumn: 'column',
          description: {
            en: 'The final statistic to display. When "Unique per" is set, this is computed on the per-entity values.',
            fr: 'La statistique finale affichée. Quand « Unique par » est défini, elle est calculée sur les valeurs par entité.',
          },
          options: [
            { value: 'mean', label: { en: 'Mean', fr: 'Moyenne' }, onlyForColumnType: 'numeric' },
            { value: 'median', label: { en: 'Median', fr: 'Médiane' }, onlyForColumnType: 'numeric' },
            { value: 'min', label: { en: 'Min', fr: 'Min' }, onlyForColumnType: 'numeric' },
            { value: 'max', label: { en: 'Max', fr: 'Max' }, onlyForColumnType: 'numeric' },
            { value: 'sum', label: { en: 'Sum', fr: 'Somme' }, onlyForColumnType: 'numeric' },
            { value: 'count', label: { en: 'Count', fr: 'Effectif' } },
            { value: 'sd', label: { en: 'Std dev', fr: 'Écart-type' }, onlyForColumnType: 'numeric' },
            { value: 'q1', label: { en: 'Q1 (25th)', fr: 'Q1 (25e)' }, onlyForColumnType: 'numeric' },
            { value: 'q3', label: { en: 'Q3 (75th)', fr: 'Q3 (75e)' }, onlyForColumnType: 'numeric' },
            { value: 'iqr', label: { en: 'IQR', fr: 'IQR' }, onlyForColumnType: 'numeric' },
            { value: 'proportion', label: { en: 'Proportion (%)', fr: 'Proportion (%)' } },
          ],
        },
        targetValue: {
          type: 'column-value-select',
          label: { en: 'Target value', fr: 'Valeur cible' },
          default: '',
          columnField: 'column',
          optional: true,
          visibleWhen: { field: 'aggregate', value: 'proportion' },
          section: { en: 'Data', fr: 'Données' },
          description: {
            en: 'The value to count for computing the proportion. Leave empty to auto-detect the most common value.',
            fr: 'La valeur à compter pour calculer la proportion. Laisser vide pour auto-détecter la valeur la plus fréquente.',
          },
        },
        uniquePer: {
          type: 'column-select',
          label: { en: 'Unique per', fr: 'Unique par' },
          optional: true,
          row: 'unique',
          section: { en: 'Data', fr: 'Données' },
          description: {
            en: 'Group rows by this column to get one value per entity. Example: group by patient_id to get one value per patient.',
            fr: 'Regroupe les lignes selon cette colonne pour obtenir une valeur par entité. Exemple : grouper par patient_id pour une valeur par patient.',
          },
        },
        uniqueAggregation: {
          type: 'select',
          label: { en: 'Per-entity function', fr: 'Fonction par entité' },
          default: 'first',
          row: 'unique',
          visibleWhen: { field: 'uniquePer', notEmpty: true },
          section: { en: 'Data', fr: 'Données' },
          description: {
            en: 'How to reduce multiple rows into one value per entity. Use "First" for values that are the same across rows (e.g. age), or "Mean" to average measurements across rows.',
            fr: "Comment réduire plusieurs lignes en une valeur par entité. Utilisez « Premier » pour les valeurs identiques entre les lignes (ex : âge), ou « Moyenne » pour moyenner des mesures.",
          },
          options: [
            { value: 'first', label: { en: 'First value', fr: 'Première valeur' } },
            { value: 'last', label: { en: 'Last value', fr: 'Dernière valeur' } },
            { value: 'mean', label: { en: 'Mean', fr: 'Moyenne' }, onlyForColumnType: 'numeric' },
            { value: 'median', label: { en: 'Median', fr: 'Médiane' }, onlyForColumnType: 'numeric' },
            { value: 'min', label: { en: 'Min', fr: 'Min' }, onlyForColumnType: 'numeric' },
            { value: 'max', label: { en: 'Max', fr: 'Max' }, onlyForColumnType: 'numeric' },
            { value: 'sum', label: { en: 'Sum', fr: 'Somme' }, onlyForColumnType: 'numeric' },
          ],
          filterOptionsByColumn: 'column',
        },
        // --- Style (collapsed by default) ---
        centerContent: {
          type: 'boolean',
          label: { en: 'Center content', fr: 'Centrer le contenu' },
          default: false,
          row: 'center',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        size: {
          type: 'number',
          label: { en: 'Size (%)', fr: 'Taille (%)' },
          default: 100,
          min: 50,
          max: 200,
          row: 'center',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        decimals: {
          type: 'number',
          label: { en: 'Decimals', fr: 'Décimales' },
          default: 1,
          min: 0,
          max: 10,
          row: 'format',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        unit: {
          type: 'string',
          label: { en: 'Unit', fr: 'Unité' },
          default: '',
          row: 'format',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        subtitleStats: {
          type: 'select',
          label: { en: 'Subtitle stats', fr: 'Stats sous-titre' },
          multi: true,
          default: ['n'],
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'n', label: { en: 'n (count)', fr: 'n (effectif)' } },
            { value: 'mean', label: { en: 'Mean', fr: 'Moyenne' } },
            { value: 'median', label: { en: 'Median', fr: 'Médiane' } },
            { value: 'sd', label: { en: 'Std dev', fr: 'Écart-type' } },
            { value: 'min', label: { en: 'Min', fr: 'Min' } },
            { value: 'max', label: { en: 'Max', fr: 'Max' } },
            { value: 'q1', label: { en: 'Q1 (25th)', fr: 'Q1 (25e)' } },
            { value: 'q3', label: { en: 'Q3 (75th)', fr: 'Q3 (75e)' } },
            { value: 'iqr', label: { en: 'IQR', fr: 'IQR' } },
          ],
        },
        chartType: {
          type: 'select',
          label: { en: 'Mini-chart', fr: 'Mini-graphique' },
          default: 'none',
          row: 'chart',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          filterOptionsByColumn: 'column',
          options: [
            { value: 'none', label: { en: 'None', fr: 'Aucun' } },
            { value: 'histogram', label: { en: 'Histogram', fr: 'Histogramme' }, onlyForColumnType: 'numeric' },
            { value: 'bar', label: { en: 'Bar chart', fr: 'Barres' } },
            { value: 'pie', label: { en: 'Pie chart', fr: 'Camembert' } },
          ],
        },
        chartBins: {
          type: 'number',
          label: { en: 'Bins', fr: 'Barres' },
          default: 15,
          min: 5,
          max: 50,
          row: 'chartOptions',
          visibleWhen: { field: 'chartType', value: 'histogram' },
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        showXAxis: {
          type: 'boolean',
          label: { en: 'X axis values', fr: 'Valeurs axe X' },
          default: false,
          row: 'chartOptions',
          visibleWhen: { field: 'chartType', value: 'histogram' },
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        chartPosition: {
          type: 'select',
          label: { en: 'Position', fr: 'Position' },
          default: 'below',
          row: 'chartLayout',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'below', label: { en: 'Below', fr: 'En dessous' } },
            { value: 'side', label: { en: 'Side', fr: 'À côté' } },
          ],
        },
        chartColors: {
          type: 'select',
          label: { en: 'Colors', fr: 'Couleurs' },
          default: 'mono',
          row: 'chartLayout',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'mono', label: { en: 'Mono', fr: 'Mono' } },
            { value: 'multi', label: { en: 'Multi', fr: 'Multi' } },
          ],
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

  registerComponent('statistical-tests', StatisticalTestsComponent)
  registerPlugin({
    manifest: normaliseManifest(statisticalTestsManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'statistical-tests',
  })

  registerComponent('regression', RegressionComponent)
  registerPlugin({
    manifest: normaliseManifest(regressionManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'regression',
  })

  registerComponent('kaplan-meier', KaplanMeierComponent)
  registerPlugin({
    manifest: normaliseManifest(kaplanMeierManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'kaplan-meier',
  })

  registerComponent('correlation-matrix', CorrelationMatrixComponent)
  registerPlugin({
    manifest: normaliseManifest(correlationMatrixManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'correlation-matrix',
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
        // Don't overwrite built-in component plugins with IDB copies that lack componentId
        const existing = getPlugin(plugin.manifest.id)
        if (existing?.componentId && !plugin.componentId) continue
        registerPlugin(plugin)
      } catch {
        // Skip plugins with invalid plugin.json
      }
    }
  } catch {
    // Storage may not be initialized yet — silently skip
  }
}
