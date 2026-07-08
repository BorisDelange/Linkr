import { apiRequest } from '@/lib/api-client'
import type { ConceptSetStorage } from '@/lib/storage'
import type { ConceptSet } from '@/types'

const SETS = '/concept-sets'

/** Server-mode ConceptSetStorage (workspace-scoped). */
export const apiConceptSetStorage: ConceptSetStorage = {
  getAll: () => apiRequest<ConceptSet[]>(SETS),

  getByWorkspace: (workspaceId) =>
    apiRequest<ConceptSet[]>(`${SETS}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<ConceptSet>(`${SETS}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (conceptSet) => {
    await apiRequest(SETS, { method: 'POST', body: JSON.stringify(conceptSet) })
  },

  update: async (id, changes) => {
    await apiRequest(`${SETS}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${SETS}/${id}`, { method: 'DELETE' })
  },

  deleteBatch: async (ids) => {
    await apiRequest(`${SETS}/delete-batch`, { method: 'POST', body: JSON.stringify({ ids }) })
  },
}
