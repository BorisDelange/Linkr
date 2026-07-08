import { apiRequest } from '@/lib/api-client'
import type { ConnectionStorage } from '@/lib/storage'
import type { IdeConnection } from '@/types'

const CONN = '/ide-connections'

/**
 * Server-mode ConnectionStorage (project-scoped IDE database connections).
 * The password/token in connectionConfig is stripped and stored encrypted
 * (Fernet) server-side and never returned — same as data sources.
 */
export const apiIdeConnectionStorage: ConnectionStorage = {
  getByProject: (projectUid) =>
    apiRequest<IdeConnection[]>(`${CONN}?projectUid=${encodeURIComponent(projectUid)}`),

  getById: async (id) => {
    try {
      return await apiRequest<IdeConnection>(`${CONN}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (connection) => {
    await apiRequest(CONN, { method: 'POST', body: JSON.stringify(connection) })
  },

  update: async (id, changes) => {
    await apiRequest(`${CONN}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${CONN}/${id}`, { method: 'DELETE' })
  },

  deleteByProject: async (projectUid) => {
    await apiRequest(`${CONN}?projectUid=${encodeURIComponent(projectUid)}`, { method: 'DELETE' })
  },
}
