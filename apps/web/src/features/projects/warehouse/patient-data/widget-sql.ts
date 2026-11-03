import type { SchemaMapping } from '@/types'
import {
  buildTimelineQuery,
  buildNotesQuery,
  buildPatientSummaryQuery,
  buildPatientVisitSummaryQuery,
} from '@/lib/duckdb/patient-data-queries'
import {
  buildOverviewDeathQuery,
  buildOverviewInventoryQuery,
  buildOverviewUnitStaysQuery,
} from '@/lib/duckdb/patient-overview-queries'
import {
  buildDataTableBoundsQuery,
  buildDataTableDensityQuery,
  buildDataTableQuery,
  type DataTableAggregate,
} from '@/lib/duckdb/patient-datatable-queries'
import {
  DATATABLE_PLUGIN_ID,
  PATIENT_SUMMARY_PLUGIN_ID,
  PATIENT_OVERVIEW_PLUGIN_ID,
  TIMELINE_PLUGIN_ID,
  NOTES_PLUGIN_ID,
} from '@/lib/plugins/builtin-widget-plugins'
import { NO_SCOPE, type PatientScope } from '@/lib/duckdb/patient-scope'

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
  /** The hospitalisation / stay the board is on (`usePatientScope`). */
  scope: PatientScope | null
  /** For the timeline: which concepts each table holds, and what each concept is. */
  timeline?: Parameters<typeof buildTimelineQuery>[4]
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
  scope,
  timeline,
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
      const sql = buildTimelineQuery(mapping, conceptIds, pid, scope, timeline)
      return [
        {
          id: 'timeline',
          label: { en: 'Measurements', fr: 'Mesures' },
          sql,
          // With concepts selected and no SQL, every event table was skipped:
          // none of them keys its concepts by id, so no id filter can apply.
          missing: sql
            ? undefined
            : conceptIds.length === 0
              ? 'conceptIds'
              : 'schemaMapping.events',
        },
      ]
    }

    case NOTES_PLUGIN_ID: {
      const sql = buildNotesQuery(mapping, pid, scope)
      return [
        {
          id: 'notes',
          label: { en: 'Notes', fr: 'Notes' },
          sql,
          missing: sql ? undefined : 'schemaMapping.note',
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
          missing: demographics ? undefined : 'schemaMapping.patient',
        },
        {
          id: 'visits',
          label: { en: 'Visits', fr: 'Séjours' },
          sql: visits,
          missing: visits ? undefined : 'schemaMapping.visit',
        },
      ]
    }

    case DATATABLE_PLUGIN_ID: {
      const conceptIds = ((config.conceptIds as number[] | undefined) ?? []).map(Number)
      const bounds = buildDataTableBoundsQuery(mapping, conceptIds, pid, scope ?? NO_SCOPE, { held: timeline?.held, label: timeline?.label })
      // The cells depend on the window the widget shows, which only it knows:
      // shown over the selected stay, when there is one.
      const window = scope?.stay ?? scope?.visit
      const cells = window?.end
        ? buildDataTableQuery(mapping, conceptIds, pid, scope ?? NO_SCOPE, {
            from: window.start,
            to: window.end,
            columns: Number(config.columns ?? 8) || 8,
            aggregate: (config.aggregate as DataTableAggregate | undefined) ?? 'mean',
            held: timeline?.held,
            label: timeline?.label,
          })
        : null
      const density = window?.end
        ? buildDataTableDensityQuery(mapping, conceptIds, pid, scope ?? NO_SCOPE, {
            from: window.start,
            to: window.end,
            buckets: 200,
            held: timeline?.held,
            label: timeline?.label,
          })
        : null
      return [
        {
          id: 'bounds',
          label: { en: 'The record’s span', fr: 'L’étendue du dossier' },
          sql: bounds,
          missing: bounds ? undefined : conceptIds.length === 0 ? 'conceptIds' : 'schemaMapping.events',
        },
        ...(cells ? [{ id: 'cells', label: { en: 'Cells, over the selected stay', fr: 'Cellules, sur le séjour choisi' }, sql: cells }] : []),
        ...(density ? [{ id: 'density', label: { en: 'Density strip, over the selected stay', fr: 'Bande de densité, sur le séjour choisi' }, sql: density }] : []),
      ]
    }

    case PATIENT_OVERVIEW_PLUGIN_ID: {
      // The record the figure is drawn from. The density strip and each row's
      // events are then asked of the concepts this inventory lists.
      const inventory = buildOverviewInventoryQuery(mapping, pid, scope ?? NO_SCOPE)
      const stays = config.showUnitStays !== false ? buildOverviewUnitStaysQuery(mapping, pid, scope?.visitId ?? null) : null
      const death = config.showDeath !== false ? buildOverviewDeathQuery(mapping, pid) : null
      return [
        {
          id: 'inventory',
          label: { en: 'Concepts of the record', fr: 'Concepts du dossier' },
          sql: inventory,
          missing: inventory ? undefined : 'schemaMapping.events',
        },
        ...(stays ? [{ id: 'unit_stays', label: { en: 'Unit stays', fr: 'Séjours en unité' }, sql: stays }] : []),
        ...(death ? [{ id: 'death', label: { en: 'Death', fr: 'Décès' }, sql: death }] : []),
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
