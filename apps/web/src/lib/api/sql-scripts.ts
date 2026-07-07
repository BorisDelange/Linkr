import { apiRequest } from '@/lib/api-client'
import type { SqlScriptCollectionStorage, SqlScriptFileStorage } from '@/lib/storage'
import type { SqlScriptCollection, SqlScriptFile } from '@/types'

const COLL = '/sql-script-collections'
const FILE = '/sql-script-files'

/** Server-mode SQL script collection storage (workspace-scoped metadata). */
export const apiSqlScriptCollectionStorage: SqlScriptCollectionStorage = {
  getAll: () => apiRequest<SqlScriptCollection[]>(COLL),

  getByWorkspace: (workspaceId) =>
    apiRequest<SqlScriptCollection[]>(`${COLL}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<SqlScriptCollection>(`${COLL}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (collection) => {
    await apiRequest(COLL, { method: 'POST', body: JSON.stringify(collection) })
  },

  update: async (id, changes) => {
    await apiRequest(`${COLL}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${COLL}/${id}`, { method: 'DELETE' })
  },
}

/** Server-mode SQL script file storage (the collection's script tree). */
export const apiSqlScriptFileStorage: SqlScriptFileStorage = {
  getByCollection: (collectionId) =>
    apiRequest<SqlScriptFile[]>(`${COLL}/${collectionId}/files`),

  getById: async (id) => {
    // No single-file GET endpoint; callers resolve files via getByCollection.
    void id
    return undefined
  },

  create: async (file) => {
    await apiRequest(FILE, { method: 'POST', body: JSON.stringify(file) })
  },

  update: async (id, changes) => {
    await apiRequest(`${FILE}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${FILE}/${id}`, { method: 'DELETE' })
  },

  deleteByCollection: async (collectionId) => {
    await apiRequest(`${COLL}/${collectionId}/files`, { method: 'DELETE' })
  },
}
