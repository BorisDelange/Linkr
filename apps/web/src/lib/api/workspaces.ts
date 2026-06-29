import { apiRequest } from '@/lib/api-client'
import type { WorkspaceStorage } from '@/lib/storage'
import type { Workspace } from '@/types'

/**
 * Server-mode implementation of WorkspaceStorage backed by the FastAPI API.
 * Responses are already camelCase, so they match the Workspace type directly.
 */
export const apiWorkspaceStorage: WorkspaceStorage = {
  getAll: () => apiRequest<Workspace[]>('/workspaces'),

  getById: async (id) => {
    try {
      return await apiRequest<Workspace>(`/workspaces/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (workspace) => {
    await apiRequest('/workspaces', {
      method: 'POST',
      body: JSON.stringify(workspace),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/workspaces/${id}`, { method: 'DELETE' })
  },
}
