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
    configSchema: {},
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
