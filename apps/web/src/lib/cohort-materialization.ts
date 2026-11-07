/**
 * Freezing a cohort's membership (its materialization). The membership query
 * comes from `buildCohortMembershipSql`; in server mode the server runs it and
 * stores the snapshot (POST /cohorts/{id}/materialize, whose
 * `cohort_service.build_materialization` mirrors `materializationFromRows`).
 */
import type { Cohort, CohortLevel, CohortMaterialization } from '@/types'
import { cohortIdColumn } from '@/lib/duckdb/cohort-query'
import { deterministicId } from '@/lib/deterministic-id'

/** The snapshot from the membership query's rows (`id`, `patient_id`). */
export function materializationFromRows(
  level: CohortLevel,
  rows: Record<string, unknown>[],
  materializedAt: string,
): CohortMaterialization {
  const ids: string[] = []
  const patients = new Set<string>()
  for (const row of rows) {
    if (row.id != null) ids.push(String(row.id))
    if (row.patient_id != null) patients.add(String(row.patient_id))
  }
  return { level, ids, patientIds: [...patients], count: ids.length, materializedAt }
}

/**
 * A run's members as a snapshot, for a patient list to read in place of the
 * criteria: what is listed is what ran. Null when the run kept only part of
 * them — its rows stop at a cap — so the list reads the criteria instead.
 */
export function runMaterialization(
  cohortId: string,
  level: CohortLevel,
  rows: Record<string, unknown>[],
  total: number,
): CohortMaterialization | null {
  if (rows.length < total) return null
  const idColumn = level === 'event' ? 'patient_id' : cohortIdColumn(level)
  const ids = rows.map((r) => String(r[idColumn]))
  return {
    level,
    ids,
    patientIds: [...new Set(rows.map((r) => String(r.patient_id)))],
    count: ids.length,
    // Stands for this run: a list re-reads its pages when it changes, so it
    // must change whenever any member does.
    materializedAt: deterministicId(cohortId, ids.join('\n')),
  }
}

/**
 * `changes` to a cohort, plus dropping its frozen membership and counts when
 * they move it to another database than the one it was frozen on — as the
 * server does on the same edit.
 */
export function withUnfreezeOnRebind(before: Cohort | undefined, changes: Partial<Cohort>): Partial<Cohort> {
  const frozen = before?.materialization
  if (!frozen || !('dataSourceId' in changes)) return changes
  if (changes.dataSourceId === before.dataSourceId || changes.dataSourceId === frozen.dataSourceId) return changes
  return { materialization: undefined, resultCount: undefined, attrition: undefined, ...changes }
}
