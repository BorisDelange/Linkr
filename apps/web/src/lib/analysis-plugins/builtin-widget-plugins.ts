/**
 * Built-in Patient Data widgets exposed as system plugins in the Warehouse scope.
 *
 * These are NOT executable plugins (no Python/R templates). They represent the
 * hard-coded JS widgets on the Patient Data page, exposed in the Plugins page
 * so users can see and customise their metadata (name, icon, badges).
 */

import type { AnalysisPlugin, AnalysisPluginManifest } from '@/types/analysis-plugin'
import type { PluginBadge } from '@/types/analysis-plugin'
import type { PatientWidgetType } from '@/stores/patient-chart-store'
import { registerAnalysisPlugin } from './registry'

// ---------------------------------------------------------------------------
// System plugin ID ↔ PatientWidgetType mapping
// ---------------------------------------------------------------------------

export const SYSTEM_WIDGET_TYPE_MAP: Record<string, PatientWidgetType> = {
  'linkr-widget-patient-summary': 'patient_summary',
  'linkr-widget-timeline': 'timeline',
  'linkr-widget-clinical-table': 'clinical_table',
  'linkr-widget-medications': 'medications',
  'linkr-widget-diagnoses': 'diagnoses',
  'linkr-widget-notes': 'notes',
}

/** Set of all system plugin IDs for quick lookup. */
export const SYSTEM_PLUGIN_IDS = new Set(Object.keys(SYSTEM_WIDGET_TYPE_MAP))

// ---------------------------------------------------------------------------
// Default manifests
// ---------------------------------------------------------------------------

const defaultManifests: AnalysisPluginManifest[] = [
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
      en: 'Line chart of numeric values over time for selected concepts.',
      fr: 'Graphique de valeurs numériques dans le temps pour les concepts sélectionnés.',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['chart', 'timeline', 'measurement'],
    runtime: [],
    languages: [],
    icon: 'TrendingUp',
    iconColor: 'blue',
    configSchema: {},
  },
  {
    id: 'linkr-widget-clinical-table',
    name: { en: 'Clinical table', fr: 'Tableau clinique' },
    description: {
      en: 'Table of clinical data with concepts and timestamps.',
      fr: 'Tableau de données cliniques avec concepts et horodatages.',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['table', 'measurement'],
    runtime: [],
    languages: [],
    icon: 'TableIcon',
    iconColor: 'green',
    configSchema: {},
  },
  {
    id: 'linkr-widget-medications',
    name: { en: 'Medications', fr: 'Médicaments' },
    description: {
      en: 'List of medications (drug exposures) for the patient.',
      fr: 'Liste des médicaments (expositions) du patient.',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['drugs', 'medications'],
    runtime: [],
    languages: [],
    icon: 'Pill',
    iconColor: 'amber',
    configSchema: {},
  },
  {
    id: 'linkr-widget-diagnoses',
    name: { en: 'Diagnoses', fr: 'Diagnostics' },
    description: {
      en: 'List of diagnoses (conditions) for the patient.',
      fr: 'Liste des diagnostics (conditions) du patient.',
    },
    version: '1.0.0',
    scope: 'warehouse',
    tags: ['conditions', 'diagnoses'],
    runtime: [],
    languages: [],
    icon: 'Stethoscope',
    iconColor: 'red',
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
// Metadata overrides (localStorage)
// ---------------------------------------------------------------------------

const OVERRIDES_KEY = 'linkr-builtin-widget-overrides'

interface BuiltinOverride {
  name?: { en: string; fr: string }
  description?: { en: string; fr: string }
  icon?: string
  iconColor?: string
  badges?: PluginBadge[]
}

function loadOverrides(): Record<string, BuiltinOverride> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, BuiltinOverride>
  } catch {
    return {}
  }
}

export function saveOverride(pluginId: string, override: BuiltinOverride): void {
  const overrides = loadOverrides()
  overrides[pluginId] = override
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
}

/** Merge default manifest with any user overrides from localStorage. */
function applyOverrides(manifest: AnalysisPluginManifest): AnalysisPluginManifest {
  const overrides = loadOverrides()
  const override = overrides[manifest.id]
  if (!override) return manifest
  return {
    ...manifest,
    ...(override.name && { name: override.name }),
    ...(override.description && { description: override.description }),
    ...(override.icon && { icon: override.icon }),
    ...(override.iconColor !== undefined && { iconColor: override.iconColor || undefined }),
    ...(override.badges && { badges: override.badges }),
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register all built-in patient data widgets as system plugins. */
export function registerBuiltinWidgetPlugins(): void {
  for (const base of defaultManifests) {
    const manifest = applyOverrides(base)
    const plugin: AnalysisPlugin = { manifest, templates: null }
    registerAnalysisPlugin(plugin)
  }
}
