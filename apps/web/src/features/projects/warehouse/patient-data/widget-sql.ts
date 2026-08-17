import type { SchemaMapping } from '@/types'
import {
  buildTimelineQuery,
  buildNotesQuery,
  buildPatientSummaryQuery,
  buildPatientVisitSummaryQuery,
} from '@/lib/duckdb/patient-data-queries'
import {
  PATIENT_SUMMARY_PLUGIN_ID,
  TIMELINE_PLUGIN_ID,
  NOTES_PLUGIN_ID,
} from '@/lib/plugins/builtin-widget-plugins'

/**
 * One query a widget runs to fetch its data.
 *
 * `sql` is null when the builder could not produce a query — which is the useful
 * case to surface: it means the schema mapping (or the config) is missing
 * something, and the widget will render empty. `missing` names what, so the SQL
 * tab answers "why do I see no data?" instead of showing a blank editor.
 */
export interface WidgetQuery {
  /** Stable key, and the label when a widget runs more than one query. */
  id: string
  label: { en: string; fr: string }
  sql: string | null
  /** Set when `sql` is null: the mapping/config field that is missing. */
  missing?: string
}

/** Placeholder patient/visit ids used when nothing is selected, so the SQL tab
 *  still shows the shape of the query rather than nothing at all. */
const SAMPLE_PATIENT = '<patient_id>'

interface BuildArgs {
  pluginId: string
  config: Record<string, unknown>
  mapping: SchemaMapping | undefined
  patientId: string | null
  visitId: string | null
}

/**
 * The queries a widget would run, in the order it runs them. Empty for a widget
 * that reads no OMOP data (a script plugin brings its own code instead).
 */
export function buildWidgetQueries({
  pluginId,
  config,
  mapping,
  patientId,
  visitId,
}: BuildArgs): WidgetQuery[] {
  if (!mapping) {
    return [
      {
        id: 'main',
        label: { en: 'Data', fr: 'Données' },
        sql: null,
        missing: 'schemaMapping',
      },
    ]
  }

  const pid = patientId ?? SAMPLE_PATIENT

  switch (pluginId) {
    case TIMELINE_PLUGIN_ID: {
      const conceptIds = (config.conceptIds as number[] | undefined) ?? []
      const sql = buildTimelineQuery(mapping, conceptIds, pid, visitId)
      return [
        {
          id: 'timeline',
          label: { en: 'Measurements', fr: 'Mesures' },
          sql,
          missing: sql
            ? undefined
            : conceptIds.length === 0
              ? 'conceptIds'
              : 'schemaMapping.eventTables',
        },
      ]
    }

    case NOTES_PLUGIN_ID: {
      const sql = buildNotesQuery(mapping, pid, visitId)
      return [
        {
          id: 'notes',
          label: { en: 'Notes', fr: 'Notes' },
          sql,
          missing: sql ? undefined : 'schemaMapping.noteTable',
        },
      ]
    }

    case PATIENT_SUMMARY_PLUGIN_ID: {
      const demographics = buildPatientSummaryQuery(mapping, pid)
      const visits = buildPatientVisitSummaryQuery(mapping, pid)
      return [
        {
          id: 'demographics',
          label: { en: 'Demographics', fr: 'Démographie' },
          sql: demographics,
          missing: demographics ? undefined : 'schemaMapping.patientTable',
        },
        {
          id: 'visits',
          label: { en: 'Visits', fr: 'Séjours' },
          sql: visits,
          missing: visits ? undefined : 'schemaMapping.visitTable',
        },
      ]
    }

    default:
      // Script plugins carry their own code, shown in the plugin editor instead.
      return []
  }
}

/** Whether this widget's query can be overridden by hand. Only widgets that read
 *  OMOP data through a single generated query qualify: the patient summary feeds
 *  a fixed layout from two queries, so an edited SQL would break its rendering
 *  with no way back. */
export function supportsCustomSql(pluginId: string): boolean {
  return pluginId === TIMELINE_PLUGIN_ID || pluginId === NOTES_PLUGIN_ID
}
