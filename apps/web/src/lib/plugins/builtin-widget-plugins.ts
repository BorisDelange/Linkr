/**
 * Built-in Patient Data widgets exposed as system plugins in the Warehouse scope.
 *
 * These are NOT executable plugins (no Python/R templates). They represent the
 * hard-coded JS widgets on the Patient Data page, exposed in the Plugins page
 * so users can see and customise their metadata (name, icon, badges).
 */

import type { Plugin, PluginManifest } from '@/types/plugin'
import type { PatientWidgetType } from '@/stores/patient-chart-store'
import { registerPlugin } from './registry'

// ---------------------------------------------------------------------------
// System plugin ID ↔ PatientWidgetType mapping
// ---------------------------------------------------------------------------

export const SYSTEM_WIDGET_TYPE_MAP: Record<string, PatientWidgetType> = {
  'linkr-widget-patient-summary': 'patient_summary',
  'linkr-widget-timeline': 'timeline',
  'linkr-widget-notes': 'notes',
}

/** Set of all system plugin IDs for quick lookup (warehouse widgets + built-in component plugins). */
export const SYSTEM_PLUGIN_IDS = new Set([
  ...Object.keys(SYSTEM_WIDGET_TYPE_MAP),
  'linkr-analysis-key-indicator',
])

// ---------------------------------------------------------------------------
// Default manifests
// ---------------------------------------------------------------------------

const defaultManifests: PluginManifest[] = [
  {
    id: 'linkr-widget-patient-summary',
    name: { en: 'Patient summary', fr: 'Résumé patient' },
    description: {
      en: 'Demographics, age, gender, and visit count.',
      fr: 'Démographie, âge, sexe et nombre de séjours.',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['demographics', 'summary'],
    runtime: [],
    languages: [],
    icon: 'User',
    iconColor: 'violet',
    configSchema: {},
  },
  {
    id: 'linkr-widget-timeline',
    name: { en: 'Timeline', fr: 'Chronologie' },
    description: {
      en: 'Interactive timeline chart for clinical measurements (dygraphs).',
      fr: 'Graphique chronologique interactif pour les mesures cliniques (dygraphs).',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['timeline', 'chart', 'measurement'],
    runtime: [],
    languages: [],
    icon: 'TrendingUp',
    iconColor: 'blue',
    // Settings rendered by the shared GenericConfigPanel in the warehouse
    // widget editor. `conceptIds` is handled separately by the Concepts tab.
    configSchema: {
      yAxisFromZero: {
        type: 'boolean',
        label: { en: 'Y axis starts at zero', fr: 'Axe Y commence à zéro' },
        default: false,
        section: { en: 'Axes', fr: 'Axes' },
        description: {
          en: 'Force the value axis to begin at 0 instead of auto-scaling.',
          fr: "Force l'axe des valeurs à démarrer à 0 au lieu de s'adapter aux données.",
        },
      },
      syncTimeRange: {
        type: 'boolean',
        label: { en: 'Synchronize timelines', fr: 'Synchroniser les chronologies' },
        default: false,
        section: { en: 'Axes', fr: 'Axes' },
        description: {
          en: 'Share the visible time window with other synced timelines in this tab.',
          fr: 'Partage la fenêtre temporelle visible avec les autres chronologies synchronisées de cet onglet.',
        },
      },
      stepPlot: {
        type: 'boolean',
        label: { en: 'Step plot', fr: 'Courbe en escalier' },
        default: false,
        section: { en: 'Appearance', fr: 'Apparence' },
        description: {
          en: 'Hold each value constant until the next measurement (staircase) instead of drawing a straight line between points. Useful for values that stay fixed between recordings, e.g. ventilator settings.',
          fr: 'Maintient chaque valeur constante jusqu\'à la mesure suivante (escalier) au lieu de relier les points par une droite. Utile pour des valeurs stables entre deux relevés, ex. réglages de ventilateur.',
        },
      },
      showPoints: {
        type: 'boolean',
        label: { en: 'Show points', fr: 'Afficher les points' },
        default: true,
        section: { en: 'Appearance', fr: 'Apparence' },
        description: {
          en: 'Draw a marker at each measurement. Turn off for dense series to keep the line readable.',
          fr: 'Affiche un marqueur à chaque mesure. À désactiver pour les séries denses afin de garder la courbe lisible.',
        },
      },
      strokeWidth: {
        type: 'select',
        label: { en: 'Line thickness', fr: 'Épaisseur du trait' },
        default: '1.5',
        section: { en: 'Appearance', fr: 'Apparence' },
        options: [
          { value: '0.5', label: { en: '0.5 px', fr: '0,5 px' } },
          { value: '1', label: { en: '1 px', fr: '1 px' } },
          { value: '1.5', label: { en: '1.5 px', fr: '1,5 px' } },
          { value: '2', label: { en: '2 px', fr: '2 px' } },
          { value: '2.5', label: { en: '2.5 px', fr: '2,5 px' } },
          { value: '3', label: { en: '3 px', fr: '3 px' } },
        ],
      },
    },
  },
  {
    id: 'linkr-widget-notes',
    name: { en: 'Clinical notes', fr: 'Notes cliniques' },
    description: {
      en: 'Document viewer for clinical notes (discharge summaries, progress notes, etc.).',
      fr: 'Visualiseur de documents cliniques (comptes-rendus, notes de suivi, etc.).',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['notes', 'nlp'],
    runtime: [],
    languages: [],
    icon: 'FileText',
    iconColor: 'cyan',
    configSchema: {},
  },
]

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register all built-in patient data widgets as system plugins. */
export function registerBuiltinWidgetPlugins(): void {
  for (const manifest of defaultManifests) {
    const plugin: Plugin = { manifest, templates: null }
    registerPlugin(plugin)
  }
}
