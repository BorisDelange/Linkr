import { apiRequest } from '@/lib/api-client'
import type { CohortStorage } from '@/lib/storage'
import type { Cohort } from '@/types'

const COHORTS = '/cohorts'

/**
 * Server-mode CohortStorage. Cohorts are keyed by id and owned by a project or
 * a database; `getAll` returns those in the caller's accessible workspaces (the
 * store then filters by owner).
 */
export const apiCohortStorage: CohortStorage = {
  getAll: () => apiRequest<Cohort[]>(COHORTS),

  getByProject: (projectUid) =>
    apiRequest<Cohort[]>(`${COHORTS}?projectUid=${encodeURIComponent(projectUid)}`),

  getByDatabase: (dataSourceId) =>
    apiRequest<Cohort[]>(`${COHORTS}?dataSourceId=${encodeURIComponent(dataSourceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<Cohort>(`${COHORTS}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (cohort) => {
    await apiRequest(COHORTS, { method: 'POST', body: JSON.stringify(cohort) })
  },

  update: async (id, changes) => {
    await apiRequest(`${COHORTS}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${COHORTS}/${id}`, { method: 'DELETE' })
  },
}

/** Freeze a cohort's membership server-side: the server runs `membershipSql`
 *  whole (no row cap) and stores the snapshot. Returns the updated cohort. */
export const materializeCohortOnServer = (id: string, body: { membershipSql: string; dataSourceId: string }) =>
  apiRequest<Cohort>(`${COHORTS}/${encodeURIComponent(id)}/materialize`, { method: 'POST', body: JSON.stringify(body) })

export const clearCohortMaterializationOnServer = (id: string) =>
  apiRequest<Cohort>(`${COHORTS}/${encodeURIComponent(id)}/materialization`, { method: 'DELETE' })
