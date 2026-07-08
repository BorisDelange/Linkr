import { apiRequest } from '@/lib/api-client'
import type { DataCatalogStorage } from '@/lib/storage'
import type { DataCatalog } from '@/types'

const CATALOGS = '/data-catalogs'

/**
 * Server-mode DataCatalogStorage (workspace-scoped config + DCAT-AP metadata).
 * Computed results (CatalogResultStorage) stay on IndexedDB — they are a heavy,
 * recomputable cache and are not persisted server-side.
 */
export const apiDataCatalogStorage: DataCatalogStorage = {
  getAll: () => apiRequest<DataCatalog[]>(CATALOGS),

  getByWorkspace: (workspaceId) =>
    apiRequest<DataCatalog[]>(`${CATALOGS}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<DataCatalog>(`${CATALOGS}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (catalog) => {
    await apiRequest(CATALOGS, { method: 'POST', body: JSON.stringify(catalog) })
  },

  update: async (id, changes) => {
    await apiRequest(`${CATALOGS}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${CATALOGS}/${id}`, { method: 'DELETE' })
  },
}
