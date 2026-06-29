import { apiRequest } from '@/lib/api-client'
import type { ProjectStorage } from '@/lib/storage'
import type { Project } from '@/types'

/**
 * Server-mode implementation of ProjectStorage backed by the FastAPI API.
 * Projects are keyed by uid; responses are already camelCase.
 */
export const apiProjectStorage: ProjectStorage = {
  getAll: () => apiRequest<Project[]>('/projects'),

  getById: async (uid) => {
    try {
      return await apiRequest<Project>(`/projects/${uid}`)
    } catch {
      return undefined
    }
  },

  create: async (project) => {
    await apiRequest('/projects', {
      method: 'POST',
      body: JSON.stringify(project),
    })
  },

  update: async (uid, changes) => {
    await apiRequest(`/projects/${uid}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (uid) => {
    await apiRequest(`/projects/${uid}`, { method: 'DELETE' })
  },
}
