import type { Storage } from '@/lib/storage'
import type { Cohort } from '@/types'

/**
 * Remove a patient board with its tabs and widgets. Children first: the server
 * cascades, but the browser's storage has no foreign keys, and a leftover child
 * collides with its deterministic id when the board is imported again.
 */
export async function deletePatientBoard(storage: Storage, boardId: string): Promise<void> {
  for (const tab of await storage.patientDashboardTabs.getByDashboard(boardId).catch(() => [])) {
    await storage.patientDashboardWidgets.deleteByTab(tab.id).catch(() => {})
  }
  await storage.patientDashboardTabs.deleteByDashboard(boardId).catch(() => {})
  await storage.patientDashboards.delete(boardId).catch(() => {})
}

/** Remove a cohort's own board, whichever owner — a database or a project — holds it. */
export async function deleteCohortBoard(
  storage: Storage,
  cohort: Pick<Cohort, 'id' | 'projectUid' | 'ownerDataSourceId'>,
): Promise<void> {
  const boards = cohort.ownerDataSourceId
    ? await storage.patientDashboards.getByDatabase(cohort.ownerDataSourceId).catch(() => [])
    : cohort.projectUid
      ? await storage.patientDashboards.getByProject(cohort.projectUid).catch(() => [])
      : []
  for (const board of boards) {
    if (board.ownerCohortId === cohort.id) await deletePatientBoard(storage, board.id)
  }
}
