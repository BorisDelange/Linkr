import { apiRequest } from '@/lib/api-client'
import type { OrganizationStorage } from '@/lib/storage'
import type { Organization } from '@/types'

/** Server-mode implementation of OrganizationStorage backed by the FastAPI API. */
export const apiOrganizationStorage: OrganizationStorage = {
  getAll: () => apiRequest<Organization[]>('/organizations'),

  getById: async (id) => {
    try {
      return await apiRequest<Organization>(`/organizations/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (org) => {
    await apiRequest('/organizations', {
      method: 'POST',
      body: JSON.stringify(org),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`/organizations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/organizations/${id}`, { method: 'DELETE' })
  },
}
