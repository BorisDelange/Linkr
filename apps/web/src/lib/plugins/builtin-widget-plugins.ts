/**
 * Built-in Patient Data widgets, registered from file-based manifests like Lab
 * plugins.
 *
 * They live in `packages/default-plugins/patient-data/<name>/plugin.json` — the
 * layout `docs/conventions.md` and the create-plugin skill already prescribe —
 * and render through `patient-component-registry`, whose props carry the OMOP
 * patient context rather than a dataset's columns/rows.
 */

import type { Plugin, PluginManifest } from '@/types/plugin'
import patientSummaryManifest from '@default-plugins/patient-data/patient-summary/plugin.json'
import timelineManifest from '@default-plugins/patient-data/timeline/plugin.json'
import notesManifest from '@default-plugins/patient-data/notes/plugin.json'
import { registerPlugin } from './registry'
import { registerPatientComponent } from './patient-component-registry'

// ---------------------------------------------------------------------------
// Component ids (manifest id → lazily-loaded React component)
// ---------------------------------------------------------------------------

export const PATIENT_SUMMARY_PLUGIN_ID = 'linkr-widget-patient-summary'
export const TIMELINE_PLUGIN_ID = 'linkr-widget-timeline'
export const NOTES_PLUGIN_ID = 'linkr-widget-notes'

/** Set of all system plugin ids (built-in patient widgets + built-in lab components). */
export const SYSTEM_PLUGIN_IDS = new Set([
  PATIENT_SUMMARY_PLUGIN_ID,
  TIMELINE_PLUGIN_ID,
  NOTES_PLUGIN_ID,
  'linkr-analysis-key-indicator',
])

const manifests = [
  { manifest: patientSummaryManifest, componentId: 'patient-summary' },
  { manifest: timelineManifest, componentId: 'timeline' },
  { manifest: notesManifest, componentId: 'notes' },
]

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the built-in patient-data widgets as file-based component plugins. */
export function registerBuiltinWidgetPlugins(): void {
  registerPatientComponent('patient-summary', () =>
    import('@/features/projects/warehouse/patient-data/widgets/PatientSummaryWidget').then(
      (m) => ({ default: m.PatientSummaryWidget }),
    ),
  )
  registerPatientComponent('timeline', () =>
    import('@/features/projects/warehouse/patient-data/widgets/TimelineWidget').then((m) => ({
      default: m.TimelineWidget,
    })),
  )
  registerPatientComponent('notes', () =>
    import('@/features/projects/warehouse/patient-data/widgets/NotesWidget').then((m) => ({
      default: m.NotesWidget,
    })),
  )

  for (const { manifest, componentId } of manifests) {
    const plugin: Plugin = {
      manifest: manifest as unknown as PluginManifest,
      templates: null,
      componentId,
    }
    registerPlugin(plugin)
  }
}
