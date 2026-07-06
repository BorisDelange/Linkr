import { apiRequest } from '@/lib/api-client'
import type { RoleStorage } from '@/lib/storage'
import type { Permission, Role } from '@/types'

/**
 * Server-mode implementation of RoleStorage backed by the FastAPI API.
 * Admin-only. Roles carry a JSON permission list drawn from getPermissions().
 */
export const apiRoleStorage: RoleStorage = {
  getAll: () => apiRequest<Role[]>('/roles'),

  getById: async (id) => {
    try {
      return await apiRequest<Role>(`/roles/${id}`)
    } catch {
      return undefined
    }
  },

  create: (role) =>
    apiRequest<Role>('/roles', {
      method: 'POST',
      body: JSON.stringify(role),
    }),

  update: async (id, changes) => {
    await apiRequest(`/roles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/roles/${id}`, { method: 'DELETE' })
  },

  getPermissions: () => apiRequest<Permission[]>('/roles/permissions'),
}
