/**
 * Guessing which dataset column plays which timeline role.
 *
 * A dataset carries no schema mapping, so every role has to be declared by hand.
 * Most datasets, though, come out of the warehouse or out of a collection form and
 * already name their identity and date columns the way everyone does: `subject_id`,
 * `hadm_id`, `charttime`. Detection fills those in so the declaration starts mostly
 * done and is corrected, not typed from scratch — leaving the variable's own value
 * column, which only its author can name.
 *
 * Two rules keep it from ever being harmful:
 *  - it only fills a role that is still UNSET, so a saved config and a deliberate
 *    choice are never overwritten;
 *  - a column is claimed by at most one role, so a single `id` column cannot end up
 *    named as both the patient and the visit.
 */
import type { DatasetColumn } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DatasetTimelineMapping } from './dataset-timeline'
import { identityColumnsFromMapping } from '@/features/projects/warehouse/patient-data/collection/identity-columns'

/** The roles detection can fill. Everything else a mapping carries names the
 *  variable rather than one of its columns, so there is nothing to detect. */
export type DetectableRole = Exclude<
  keyof DatasetTimelineMapping,
  'datasetFileId' | 'seriesName' | 'color'
>

/**
 * Candidate names per role, best first.
 *
 * Matching is exact (case-insensitive) rather than substring: `valuenum` and
 * `value_as_string` both contain "value", and a substring rule would hand the
 * numeric role to whichever came first in the column order. The lists are ordered
 * by how specific the name is, so `value_as_number` wins over a bare `value`.
 */
const CANDIDATES: Record<DetectableRole, string[]> = {
  personColumn: ['person_id', 'subject_id', 'patient_id', 'patientid'],
  visitColumn: ['visit_occurrence_id', 'hadm_id', 'encounter_id', 'admission_id', 'stay_id'],
  visitDetailColumn: ['visit_detail_id', 'icustay_id', 'transfer_id', 'unit_stay_id'],
  dateColumn: [
    'start_datetime', 'starttime', 'start_time', 'charttime', 'chart_time',
    'event_date', 'eventdate', 'datetime', 'date', 'time', 'measurement_datetime',
    'observation_datetime',
  ],
  endColumn: ['end_datetime', 'endtime', 'end_time', 'end_date', 'stoptime', 'enddate'],
  valueColumn: [
    'value_as_number', 'valuenum', 'value_num', 'numeric_value', 'value', 'result',
    'measurement',
  ],
  textValueColumn: [
    'value_as_string', 'valuestr', 'value_string', 'text_value', 'value_text',
    'valueuom', 'result_text',
  ],
}

/**
 * The order roles are resolved in, most specific first.
 *
 * It matters because of the one-column-one-role rule: a dataset whose date column
 * is simply `date` should not have it claimed by `endColumn` first.
 */
const RESOLUTION_ORDER: DetectableRole[] = [
  'personColumn',
  'visitColumn',
  'visitDetailColumn',
  'dateColumn',
  'endColumn',
  'valueColumn',
  'textValueColumn',
]

/** Only a column that can hold a moment in time is offered as a date. */
function plausible(role: DetectableRole, col: DatasetColumn): boolean {
  if (role === 'dateColumn' || role === 'endColumn') return col.type !== 'boolean'
  if (role === 'valueColumn') return col.type === 'number'
  return true
}

/**
 * Fill in the roles a dataset's column names give away.
 *
 * `mapping` is the ACTIVE DATABASE's schema mapping: its patient/visit id names take
 * priority over the generic list, so a collection built against MIMIC matches on
 * `subject_id` even where a stock CDM would say `person_id`.
 *
 * Returns only the roles it filled — the caller merges, so an empty object means
 * "nothing to change" and must not clear anything.
 */
export function detectDatasetRoles(
  columns: readonly DatasetColumn[],
  current: Partial<DatasetTimelineMapping>,
  mapping?: SchemaMapping,
): Partial<DatasetTimelineMapping> {
  if (columns.length === 0) return {}

  const byName = new Map<string, DatasetColumn>()
  for (const col of columns) {
    const key = col.name.trim().toLowerCase()
    // First wins: two columns with the same name is a broken dataset, and the
    // earlier one is the one the parser kept.
    if (!byName.has(key)) byName.set(key, col)
  }

  // A column already named by the user is spoken for, so detection never
  // duplicates it into a second role.
  const taken = new Set<string>()
  for (const role of RESOLUTION_ORDER) {
    const value = current[role]
    if (typeof value === 'string' && value) taken.add(value)
  }

  const preferred: Partial<Record<DetectableRole, string>> = {}
  for (const identity of identityColumnsFromMapping(mapping)) {
    const role = identity.role === 'person' ? 'personColumn'
      : identity.role === 'visit' ? 'visitColumn'
        : 'visitDetailColumn'
    preferred[role] = identity.name.toLowerCase()
  }

  const found: Partial<DatasetTimelineMapping> = {}
  for (const role of RESOLUTION_ORDER) {
    if (current[role]) continue
    const names = preferred[role]
      ? [preferred[role]!, ...CANDIDATES[role].filter((n) => n !== preferred[role])]
      : CANDIDATES[role]
    for (const name of names) {
      const col = byName.get(name)
      if (!col || taken.has(col.id) || !plausible(role, col)) continue
      found[role] = col.id
      taken.add(col.id)
      break
    }
  }
  return found
}
