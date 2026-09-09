/**
 * Entry constraints for a collected variable.
 *
 * These describe what a collector may TYPE, not what the dataset may hold. A
 * violation is reported next to the field and never blocks the write: a value that
 * is out of range is usually a typo worth flagging, but occasionally the real
 * measurement, and refusing it would leave the collector with no way to record what
 * actually happened. The same reasoning keeps them out of import validation — a
 * constraint authored today cannot retroactively make yesterday's data invalid.
 */
import type { DatasetColumn } from '@/types'

export interface Violation {
  /** i18n key of the message to show. */
  key: string
  params?: Record<string, unknown>
}

/** What is wrong with `value` for `column`, or null when nothing is. */
export function violationOf(column: DatasetColumn, value: unknown): Violation | null {
  const empty = value == null || value === ''
  if (empty) {
    return column.required ? { key: 'datasets.constraint_required' } : null
  }

  if (column.allowedValues?.length && !column.allowedValues.includes(String(value))) {
    return { key: 'datasets.constraint_not_allowed', params: { values: column.allowedValues.join(', ') } }
  }

  if (column.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return { key: 'datasets.constraint_not_a_number' }
    if (column.min != null && n < Number(column.min)) {
      return { key: 'datasets.constraint_min', params: { min: column.min } }
    }
    if (column.max != null && n > Number(column.max)) {
      return { key: 'datasets.constraint_max', params: { max: column.max } }
    }
  }

  if (column.type === 'date') {
    // Compared as ISO strings, which sort chronologically — parsing to Date would
    // reintroduce the timezone shift the rest of the app carefully avoids.
    const iso = String(value)
    if (column.min != null && iso < String(column.min)) {
      return { key: 'datasets.constraint_after', params: { min: column.min } }
    }
    if (column.max != null && iso > String(column.max)) {
      return { key: 'datasets.constraint_before', params: { max: column.max } }
    }
  }

  return null
}

/** Collection progress for one patient: how many required fields are still empty. */
export function completionOf(
  fields: { column: DatasetColumn; value: unknown }[],
): { filled: number; total: number; missingRequired: number } {
  let filled = 0
  let missingRequired = 0
  for (const { column, value } of fields) {
    const empty = value == null || value === ''
    if (!empty) filled++
    else if (column.required) missingRequired++
  }
  return { filled, total: fields.length, missingRequired }
}
