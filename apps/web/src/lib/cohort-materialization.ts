/**
 * Freezing a cohort's membership (its materialization). The membership query
 * comes from `buildCohortMembershipSql`; in server mode the server runs it and
 * stores the snapshot (POST /cohorts/{id}/materialize, whose
 * `cohort_service.build_materialization` mirrors `materializationFromRows`).
 */
import type { CohortLevel, CohortMaterialization } from '@/types'

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
