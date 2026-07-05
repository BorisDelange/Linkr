import { apiRequest } from '@/lib/api-client'
import type { WikiPageStorage } from '@/lib/storage'
import type { WikiPage } from '@/types'

/**
 * Server-mode implementation of WikiPageStorage backed by the FastAPI API.
 * Pages are keyed by id and scoped to a workspace; responses are already camelCase.
 */
export const apiWikiPageStorage: WikiPageStorage = {
  getByWorkspace: (workspaceId) =>
    apiRequest<WikiPage[]>(`/wiki-pages?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<WikiPage>(`/wiki-pages/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (page) => {
    await apiRequest('/wiki-pages', {
      method: 'POST',
      body: JSON.stringify(page),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`/wiki-pages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/wiki-pages/${id}`, { method: 'DELETE' })
  },

  deleteByWorkspace: async (workspaceId) => {
    await apiRequest(`/wiki-pages?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    })
  },
}
