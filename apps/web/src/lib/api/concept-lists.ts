import { apiRequest } from '@/lib/api-client'
import type { ConceptListStorage } from '@/lib/storage'
import type { ConceptList } from '@/types'

const LISTS = '/concept-lists'

/** Server-mode ConceptListStorage (project-scoped). */
export const apiConceptListStorage: ConceptListStorage = {
  getAll: () => apiRequest<ConceptList[]>(LISTS),

  getByProject: (projectUid) =>
    apiRequest<ConceptList[]>(`${LISTS}?projectUid=${encodeURIComponent(projectUid)}`),

  getById: async (id) => {
    try {
      return await apiRequest<ConceptList>(`${LISTS}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (conceptList) => {
    await apiRequest(LISTS, { method: 'POST', body: JSON.stringify(conceptList) })
  },

  update: async (id, changes) => {
    await apiRequest(`${LISTS}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${LISTS}/${id}`, { method: 'DELETE' })
  },
}
