import { apiRequest } from '@/lib/api-client'
import type { PipelineStorage } from '@/lib/storage'
import type { Pipeline } from '@/types'

/**
 * Server-mode implementation of PipelineStorage backed by the FastAPI API.
 * Pipelines are keyed by id and scoped to a project; `getAll` returns those in
 * the caller's accessible workspaces (the store then filters by project).
 */
export const apiPipelineStorage: PipelineStorage = {
  getAll: () => apiRequest<Pipeline[]>('/pipelines'),

  getByProject: (projectUid) =>
    apiRequest<Pipeline[]>(`/pipelines?projectUid=${encodeURIComponent(projectUid)}`),

  getById: async (id) => {
    try {
      return await apiRequest<Pipeline>(`/pipelines/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (pipeline) => {
    await apiRequest('/pipelines', { method: 'POST', body: JSON.stringify(pipeline) })
  },

  update: async (id, changes) => {
    await apiRequest(`/pipelines/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`/pipelines/${id}`, { method: 'DELETE' })
  },
}
