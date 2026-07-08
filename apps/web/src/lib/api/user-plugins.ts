import { apiRequest } from '@/lib/api-client'
import type { UserPluginStorage } from '@/lib/storage'
import type { UserPlugin } from '@/types'

const PLUGINS = '/user-plugins'

/** Server-mode UserPluginStorage (plugin files stored inline; workspace optional). */
export const apiUserPluginStorage: UserPluginStorage = {
  getAll: () => apiRequest<UserPlugin[]>(PLUGINS),

  getByWorkspace: (workspaceId) =>
    apiRequest<UserPlugin[]>(`${PLUGINS}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<UserPlugin>(`${PLUGINS}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (plugin) => {
    await apiRequest(PLUGINS, { method: 'POST', body: JSON.stringify(plugin) })
  },

  update: async (id, changes) => {
    await apiRequest(`${PLUGINS}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${PLUGINS}/${id}`, { method: 'DELETE' })
  },
}
