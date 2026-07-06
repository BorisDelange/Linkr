import { apiRequest } from '@/lib/api-client'
import type { UserStorage } from '@/lib/storage'
import type { User } from '@/types'

/**
 * Server-mode implementation of UserStorage backed by the FastAPI API.
 * Admin-only endpoints; responses are camelCase and never include the password hash.
 */
export const apiUserStorage: UserStorage = {
  getAll: () => apiRequest<User[]>('/users'),

  getById: async (id) => {
    try {
      return await apiRequest<User>(`/users/${id}`)
    } catch {
      return undefined
    }
  },

  create: (user) =>
    apiRequest<User>('/users', {
      method: 'POST',
      body: JSON.stringify(user),
    }),

  update: async (id, changes) => {
    await apiRequest(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/users/${id}`, { method: 'DELETE' })
  },
}
