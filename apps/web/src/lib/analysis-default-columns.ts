/**
 * Which columns an analysis should tick by default when it offers "all".
 *
 * "All columns" is the right starting point for a table or a battery of tests,
 * but two families are never what the user meant and produce noise that has to
 * be unticked by hand every time:
 *
 *  - **identifiers** — a patient id has a mean, a median and a set of levels,
 *    all of them meaningless. Worse, an id column is usually near-unique, so it
 *    renders one row per patient and buries the real variables;
 *  - **dates** — a descriptive table of raw timestamps says nothing useful, and
 *    a test on them compares epoch milliseconds. A derived duration is what
 *    people actually want, and that is a different column.
 *
 * They are only DESELECTED, never hidden: the user can tick them back, because
 * an id can legitimately be the grouping variable and a date can legitimately be
 * the thing you are describing.
 */

import type { DatasetColumn } from '@/types'

/**
 * Does this column name read as an identifier?
 *
 * Matches `id` alone and anything ending in `_id` / `-id` / `.id`, case
 * insensitively — the shapes an export actually produces (`patient_id`,
 * `subject-id`, `visit.id`). Deliberately NOT a bare `*id` suffix: that would
 * also catch `valid`, `covid` and `fluid`, which are real variables.
 */
export function looksLikeIdentifier(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n === 'id' || /[_\-.]id$/.test(n)
}

/** Whether a column is ticked when an analysis defaults to "all columns". */
export function isDefaultAnalysisColumn(column: DatasetColumn): boolean {
  if (looksLikeIdentifier(column.name)) return false
  if (column.type === 'date') return false
  return true
}

/** The columns an analysis starts with, given every column it could offer. */
export function defaultAnalysisColumns(columns: DatasetColumn[]): DatasetColumn[] {
  const kept = columns.filter(isDefaultAnalysisColumn)
  // Everything was excluded — a dataset of nothing but ids and dates. Offer them
  // all rather than an empty analysis the user cannot explain.
  return kept.length > 0 ? kept : columns
}
