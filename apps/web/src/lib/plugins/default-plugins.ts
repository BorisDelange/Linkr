import type { Plugin, PluginManifest } from '@/types/plugin'
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
import plotBuilderManifest from '@default-plugins/analyses/plot-builder/plugin.json'
import mapManifest from '@default-plugins/analyses/map/plugin.json'
import statisticalTestsManifest from '@default-plugins/analyses/statistical-tests/plugin.json'
import regressionManifest from '@default-plugins/analyses/regression/plugin.json'
import kaplanMeierManifest from '@default-plugins/analyses/kaplan-meier/plugin.json'
import correlationMatrixManifest from '@default-plugins/analyses/correlation-matrix/plugin.json'
import sankeyManifest from '@default-plugins/analyses/sankey/plugin.json'
import surveyQuestionManifest from '@default-plugins/analyses/survey-question/plugin.json'

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

// Adding/removing/renaming a Lab plugin (or changing its column-select config
// keys) also invalidates the create-project skill's built-in widget inventory:
// keep .claude/skills/create-project/{references/dashboards.md,assets/build_zip.py}
// (PLUGIN_COLUMN_KEYS) in sync.
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
            { value: 'tableau', label: { en: 'Tableau (classic)', fr: 'Tableau (classique)' } },
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

  // Warehouse system plugins (built-in patient data widgets)
  registerBuiltinWidgetPlugins()

  // Snapshot the canonical built-ins now, before any workspace-scoped user plugin
  // is registered on top (registerUserPlugins overwrites same-id entries with a
  // workspaceId set). The seeder must not rely on the mutable registry, otherwise
  // built-ins look "workspace-scoped" and stop being seeded from the 2nd workspace on.
  builtinSnapshot = getAllPlugins()
    .filter((p) => !p.workspaceId)
    .map((p) => ({ manifest: p.manifest, templates: p.templates }))
  builtinManifestIds = new Set(builtinSnapshot.map((p) => p.manifest.id))
}

/** Frozen list of built-in plugins captured at registration time (see above). */
let builtinSnapshot: { manifest: import('@/types/plugin').PluginManifest; templates: Record<string, string> | null }[] = []
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
    : getAllPlugins().filter((p) => !p.workspaceId).map((p) => ({ manifest: p.manifest, templates: p.templates }))
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
