import { apiRequest } from '@/lib/api-client'
import type { CohortStorage } from '@/lib/storage'
import type { Cohort } from '@/types'

const COHORTS = '/cohorts'

/**
 * Server-mode CohortStorage. Cohorts are keyed by id and scoped to a project;
 * `getAll` returns those in the caller's accessible workspaces (the store then
 * filters by project).
 */
export const apiCohortStorage: CohortStorage = {
  getAll: () => apiRequest<Cohort[]>(COHORTS),

  getByProject: (projectUid) =>
    apiRequest<Cohort[]>(`${COHORTS}?projectUid=${encodeURIComponent(projectUid)}`),

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
