/**
 * What "this hospitalisation" and "this stay" mean in SQL, for every patient
 * widget that honours the selection (Data overview, Timeline, Notes).
 *
 * A hospitalisation is matched by the row's visit id when the mapping records
 * one, and by the hospitalisation's dates otherwise — filtering a visit column
 * the mapping left NULL would empty the widget, and ignoring the selection
 * would show every hospitalisation under one.
 *
 * A unit stay is always matched by TIME: OMOP's `visit_detail_id` is present on
 * the event tables but NULL for every row of the sample warehouse, and in
 * MIMIC-IV `chartevents` has `stay_id` while `labevents` has no such column at
 * all. The stay's time window is what "during this stay" means clinically.
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import { classRelation, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { escSql } from '@/lib/format-helpers'
import { toMs } from '@/lib/duckdb/value-coercion'

/** A hospitalisation's or a stay's dates; an open one has no end. */
export interface TimeWindow {
  start: string
  end: string | null
}

/** The selection a widget is scoped to, below the patient. */
export interface PatientScope {
  visitId: string | null
  /** The selected hospitalisation's dates, for rows that record no visit id. */
  visit: TimeWindow | null
  /** The selected unit stay's dates. */
  stay: TimeWindow | null
}

export const NO_SCOPE: PatientScope = { visitId: null, visit: null, stay: null }

/** The dates of one hospitalisation (`window_start`, `window_end`). */
export function buildVisitWindowQuery(mapping: SchemaMapping, visitId: string): string | null {
  const visit = classRelation(mapping, 'visit')
  if (!visit || !has(visit, 'start_datetime')) return null
  return `SELECT start_datetime AS window_start,
  ${has(visit, 'end_datetime') ? 'end_datetime' : 'NULL'} AS window_end
FROM ${visit.name}
WHERE visit_id = '${escSql(visitId)}'
LIMIT 1`
}

/** The dates of one unit stay (`window_start`, `window_end`). */
export function buildStayWindowQuery(mapping: SchemaMapping, visitDetailId: string): string | null {
  const vd = classRelation(mapping, 'visit_detail')
  if (!vd) return null
  return `SELECT start_datetime AS window_start,
  end_datetime AS window_end
FROM ${vd.name}
WHERE visit_detail_id = '${escSql(visitDetailId)}'
LIMIT 1`
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A window bound as `windowCondition` takes it. A DATE stays date-only — both
 * engines return one as `YYYY-MM-DD` — so that a window ending on a date keeps
 * that whole day, while one ending on a timestamp at midnight stops there.
 * Anything else becomes its UTC ISO instant.
 */
export function windowBound(value: unknown): string | null {
  if (typeof value === 'string' && DATE_ONLY.test(value.trim())) return value.trim()
  const ms = toMs(value)
  return ms == null ? null : new Date(ms).toISOString()
}

/**
 * `AND`-clause keeping the rows that overlap a window, or '' without one.
 * With `endColumn`, a row that started before the window and is still running
 * in it counts — an infusion started before admission is still running during it.
 */
export function windowCondition(window: TimeWindow | null, dateColumn: string, endColumn: string | null = null): string {
  if (!window) return ''
  const end = endColumn ? `COALESCE(${endColumn}, ${dateColumn})` : dateColumn
  const upperBound = window.end && `TIMESTAMP '${escSql(window.end)}'`
  const upper = !upperBound
    ? ''
    : DATE_ONLY.test(window.end!)
      ? `\n  AND ${dateColumn} < ${upperBound} + INTERVAL 1 DAY`
      : `\n  AND ${dateColumn} <= ${upperBound}`
  return `\n  AND ${end} >= TIMESTAMP '${escSql(window.start)}'${upper}`
}

/**
 * `AND`-clauses scoping a relation to the selection: its visit id (else the
 * hospitalisation's dates), then the stay's dates. `dateColumn` / `endColumn`
 * name the row's own dates; a relation with no date cannot be scoped by time.
 */
export function scopeCondition(
  mapping: SchemaMapping,
  rel: ClassRelation,
  scope: PatientScope,
  dateColumn: string | null,
  endColumn: string | null = null,
  alias = 'e',
): string {
  const col = (c: string | null) => (c ? `${alias}.${c}` : null)
  let visit = ''
  if (scope.visitId && classRelation(mapping, 'visit')) {
    visit = has(rel, 'visit_id')
      ? `\n  AND ${alias}.visit_id = '${escSql(scope.visitId)}'`
      : dateColumn ? windowCondition(scope.visit, col(dateColumn)!, col(endColumn)) : ''
  }
  const stay = dateColumn ? windowCondition(scope.stay, col(dateColumn)!, col(endColumn)) : ''
  return visit + stay
}

/** `scopeCondition` for an event relation, through its mapped start / end dates. */
export function eventScopeCondition(mapping: SchemaMapping, event: ClassRelation, scope: PatientScope, alias = 'e'): string {
  return scopeCondition(
    mapping,
    event,
    scope,
    has(event, 'start_datetime') ? 'start_datetime' : null,
    has(event, 'end_datetime') ? 'end_datetime' : null,
    alias,
  )
}
