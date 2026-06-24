import type { Plugin, PluginManifest } from '@/types/plugin'
import { registerPlugin, getPlugin } from './registry'
import { registerComponent } from './component-registry'
import { registerBuiltinWidgetPlugins, SYSTEM_PLUGIN_IDS } from './builtin-widget-plugins'
import { getStorage } from '@/lib/storage'
import { KeyIndicatorComponent } from '@/features/projects/lab/datasets/analyses/KeyIndicatorComponent'
import { PlotBuilderComponent } from '@/features/projects/lab/datasets/analyses/PlotBuilderComponent'
import { MapComponent } from '@/features/projects/lab/datasets/analyses/MapComponent'
import { Table1Component } from '@/features/projects/lab/datasets/analyses/Table1Component'
import { StatisticalTestsComponent } from '@/features/projects/lab/datasets/analyses/StatisticalTestsComponent'
import { RegressionComponent } from '@/features/projects/lab/datasets/analyses/RegressionComponent'
import { KaplanMeierComponent } from '@/features/projects/lab/datasets/analyses/KaplanMeierComponent'
import { CorrelationMatrixComponent } from '@/features/projects/lab/datasets/analyses/CorrelationMatrixComponent'
import { SankeyComponent } from '@/features/projects/lab/datasets/analyses/SankeyComponent'

// --- Plugin manifests (JSON) ---
import table1Manifest from '@default-plugins/analyses/table1/plugin.json'
import plotBuilderManifest from '@default-plugins/analyses/plot-builder/plugin.json'
import mapManifest from '@default-plugins/analyses/map/plugin.json'
import statisticalTestsManifest from '@default-plugins/analyses/statistical-tests/plugin.json'
import regressionManifest from '@default-plugins/analyses/regression/plugin.json'
import kaplanMeierManifest from '@default-plugins/analyses/kaplan-meier/plugin.json'
import correlationMatrixManifest from '@default-plugins/analyses/correlation-matrix/plugin.json'
import sankeyManifest from '@default-plugins/analyses/sankey/plugin.json'

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
        // --- Data ---
        column: {
          type: 'column-select',
          label: { en: 'Column', fr: 'Colonne' },
          section: { en: 'Data', fr: 'Données' },
          autoSet: {
            numeric: { aggregate: 'mean', unit: '', targetValue: '' },
            categorical: { aggregate: 'proportion', unit: '%', targetValue: '' },
          },
        },
        targetValue: {
          type: 'column-value-select',
          label: { en: 'Target value', fr: 'Valeur cible' },
          default: '',
          columnField: 'column',
          optional: true,
          visibleWhen: { field: 'aggregate', values: ['proportion', 'count'] },
          section: { en: 'Data', fr: 'Données' },
          description: {
            en: 'The value to count (for Count or Proportion). Leave empty to count all non-empty rows, or auto-detect the most common value for Proportion.',
            fr: 'La valeur à compter (pour Effectif ou Proportion). Laisser vide pour compter toutes les lignes non vides, ou auto-détecter la valeur la plus fréquente pour Proportion.',
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
        excludeNA: {
          type: 'boolean',
          label: { en: 'Exclude NA / empty', fr: 'Exclure NA / vide' },
          default: true,
          section: { en: 'Data', fr: 'Données' },
          description: {
            en: 'Drop rows whose value is null, empty, or NA before computing the indicator. Uncheck to count them.',
            fr: 'Ignore les lignes dont la valeur est nulle, vide ou NA avant de calculer l’indicateur. Décocher pour les comptabiliser.',
          },
        },
        // --- Content ---
        title: {
          type: 'string',
          label: { en: 'Title', fr: 'Titre' },
          default: '',
          section: { en: 'Content', fr: 'Contenu' },
        },
        aggregate: {
          type: 'select',
          label: { en: 'Stat', fr: 'Statistique' },
          default: 'mean',
          section: { en: 'Content', fr: 'Contenu' },
          filterOptionsByColumn: 'column',
          description: {
            en: 'The main statistic to display. When "Unique per" is set, this is computed on the per-entity values.',
            fr: 'La statistique principale affichée. Quand « Unique par » est défini, elle est calculée sur les valeurs par entité.',
          },
          options: [
            { value: 'none', label: { en: 'None', fr: 'Aucune' } },
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
        decimals: {
          type: 'number',
          label: { en: 'Decimals', fr: 'Décimales' },
          default: 1,
          min: 0,
          max: 10,
          row: 'format',
          section: { en: 'Content', fr: 'Contenu' },
        },
        unit: {
          type: 'string',
          label: { en: 'Unit', fr: 'Unité' },
          default: '',
          row: 'format',
          section: { en: 'Content', fr: 'Contenu' },
        },
        subtitleStats: {
          type: 'select',
          label: { en: 'Subtitle stats', fr: 'Stats sous-titre' },
          multi: true,
          default: ['n'],
          section: { en: 'Content', fr: 'Contenu' },
          filterOptionsByColumn: 'column',
          options: [
            { value: 'n', label: { en: 'n (count)', fr: 'n (effectif)' } },
            { value: 'mean', label: { en: 'Mean', fr: 'Moyenne' }, onlyForColumnType: 'numeric' },
            { value: 'median', label: { en: 'Median', fr: 'Médiane' }, onlyForColumnType: 'numeric' },
            { value: 'sd', label: { en: 'Std dev', fr: 'Écart-type' }, onlyForColumnType: 'numeric' },
            { value: 'min', label: { en: 'Min', fr: 'Min' }, onlyForColumnType: 'numeric' },
            { value: 'max', label: { en: 'Max', fr: 'Max' }, onlyForColumnType: 'numeric' },
            { value: 'q1', label: { en: 'Q1 (25th)', fr: 'Q1 (25e)' }, onlyForColumnType: 'numeric' },
            { value: 'q3', label: { en: 'Q3 (75th)', fr: 'Q3 (75e)' }, onlyForColumnType: 'numeric' },
            { value: 'iqr', label: { en: 'IQR', fr: 'IQR' }, onlyForColumnType: 'numeric' },
          ],
        },
        // --- Mini-chart ---
        chartType: {
          type: 'select',
          label: { en: 'Chart type', fr: 'Type de graphique' },
          default: 'none',
          row: 'chart',
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
          filterOptionsByColumn: 'column',
          options: [
            { value: 'none', label: { en: 'None', fr: 'Aucun' } },
            { value: 'histogram', label: { en: 'Histogram', fr: 'Histogramme' }, onlyForColumnType: 'numeric' },
            { value: 'bar', label: { en: 'Bar chart', fr: 'Barres' } },
            { value: 'pie', label: { en: 'Pie chart', fr: 'Camembert' } },
          ],
        },
        chartPosition: {
          type: 'select',
          label: { en: 'Position', fr: 'Position' },
          default: 'below',
          row: 'chart',
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
          options: [
            { value: 'below', label: { en: 'Below', fr: 'En dessous' } },
            { value: 'side', label: { en: 'Side', fr: 'À côté' } },
          ],
        },
        chartBins: {
          type: 'number',
          label: { en: 'Bins', fr: 'Barres' },
          default: 15,
          min: 5,
          max: 50,
          row: 'chartBinsColors',
          visibleWhen: { field: 'chartType', value: 'histogram' },
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
        },
        xAxisLabel: {
          type: 'string',
          label: { en: 'X axis label', fr: 'Légende axe X' },
          default: '',
          row: 'chartXAxis',
          // Pie has no X axis; only histogram and bar render this label.
          visibleWhen: { field: 'chartType', values: ['histogram', 'bar'] },
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
        },
        showXAxis: {
          type: 'boolean',
          label: { en: 'X axis ticks', fr: 'Graduations axe X' },
          default: false,
          row: 'chartXAxis',
          // Only the histogram has a numeric X axis; categorical bar charts render horizontally with no X ticks.
          visibleWhen: { field: 'chartType', value: 'histogram' },
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
        },
        yLabelMaxLen: {
          type: 'number',
          label: { en: 'Y label length', fr: 'Longueur labels Y' },
          default: 11,
          min: 3,
          max: 40,
          row: 'chartXAxis',
          // Only the horizontal bar chart has truncatable category labels on the Y axis.
          visibleWhen: { field: 'chartType', value: 'bar' },
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
          description: {
            en: 'Maximum number of characters shown for each Y-axis category label (longer labels are truncated with “…”).',
            fr: 'Nombre maximum de caractères affichés pour chaque label de catégorie sur l’axe Y (les plus longs sont tronqués avec « … »).',
          },
        },
        xAxisStartZero: {
          type: 'boolean',
          label: { en: 'X axis starts at 0', fr: 'Axe X commence à 0' },
          default: false,
          row: 'chartXAxisOptions',
          visibleWhen: { field: 'chartType', value: 'histogram' },
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
        },
        chartPalette: {
          type: 'select',
          label: { en: 'Color palette', fr: 'Palette' },
          default: 'none',
          optionPreview: 'palette',
          row: 'chartBinsColors',
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
          options: [
            { value: 'none', label: { en: 'None (single color)', fr: 'Aucune (couleur unique)' } },
            { value: 'default', label: { en: 'Default', fr: 'Par défaut' } },
            { value: 'tableau10', label: { en: 'Tableau 10', fr: 'Tableau 10' } },
            { value: 'pastel', label: { en: 'Pastel', fr: 'Pastel' } },
            { value: 'vivid', label: { en: 'Vivid', fr: 'Vives' } },
            { value: 'earth', label: { en: 'Earth tones', fr: 'Tons terre' } },
            { value: 'ocean', label: { en: 'Ocean', fr: 'Océan' } },
            { value: 'warm', label: { en: 'Warm', fr: 'Chaud' } },
            { value: 'cool', label: { en: 'Cool', fr: 'Froid' } },
            { value: 'monochrome', label: { en: 'Monochrome', fr: 'Monochrome' } },
            { value: 'custom', label: { en: 'Custom…', fr: 'Personnalisée…' } },
          ],
        },
        chartCustomPalette: {
          type: 'palette-editor',
          label: { en: 'Custom colors', fr: 'Couleurs personnalisées' },
          default: '',
          visibleWhen: { field: 'chartPalette', value: 'custom' },
          section: { en: 'Mini-chart', fr: 'Mini-graphique', defaultOpen: false },
        },
        // --- Style ---
        size: {
          type: 'number',
          label: { en: 'Size (%)', fr: 'Taille (%)' },
          default: 100,
          min: 50,
          max: 200,
          row: 'iconSizeRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        icon: {
          type: 'icon-select',
          label: { en: 'Icon', fr: 'Icône' },
          default: 'Activity',
          row: 'iconSizeRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        centerTitle: {
          type: 'boolean',
          label: { en: 'Center title', fr: 'Centrer le titre' },
          default: true,
          row: 'centerRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        centerContent: {
          type: 'boolean',
          label: { en: 'Center content', fr: 'Centrer le contenu' },
          default: true,
          row: 'centerRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        color: {
          type: 'color-select',
          label: { en: 'Main', fr: 'Principale' },
          default: 'blue',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
        },
        bgColor: {
          type: 'color-select',
          label: { en: 'Background', fr: 'Fond' },
          default: 'none',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'none', label: { en: 'None', fr: 'Aucun' } },
          ],
        },
        iconColor: {
          type: 'color-select',
          label: { en: 'Icon', fr: 'Icône' },
          default: 'auto',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'auto', label: { en: 'Auto', fr: 'Auto' } },
          ],
        },
        valueColor: {
          type: 'color-select',
          label: { en: 'Main value', fr: 'Valeur principale' },
          default: 'auto',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'auto', label: { en: 'Auto', fr: 'Auto' } },
          ],
        },
        titleColor: {
          type: 'color-select',
          label: { en: 'Title', fr: 'Titre' },
          default: 'auto',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'auto', label: { en: 'Auto', fr: 'Auto' } },
          ],
        },
        unitColor: {
          type: 'color-select',
          label: { en: 'Unit', fr: 'Unité' },
          default: 'auto',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'auto', label: { en: 'Auto', fr: 'Auto' } },
          ],
        },
        subtitleColor: {
          type: 'color-select',
          label: { en: 'Subtitle', fr: 'Sous-titre' },
          default: 'auto',
          row: 'colorsRow',
          section: { en: 'Style', fr: 'Style', defaultOpen: false },
          options: [
            { value: 'auto', label: { en: 'Auto', fr: 'Auto' } },
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

  registerComponent('map', MapComponent)
  registerPlugin({
    manifest: normaliseManifest(mapManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'map',
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

  registerComponent('sankey', SankeyComponent)
  registerPlugin({
    manifest: normaliseManifest(sankeyManifest as unknown as Record<string, unknown>),
    templates: null,
    componentId: 'sankey',
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
        // System widgets (e.g. timeline) own functional fields like configSchema
        // in code; persisted copies only carry editable metadata. Preserve the
        // built-in's schema so customising metadata can't drop the settings form.
        if (existing && SYSTEM_PLUGIN_IDS.has(plugin.manifest.id)) {
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
