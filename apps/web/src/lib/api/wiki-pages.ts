import { apiRequest } from '@/lib/api-client'
import type { WikiPageStorage } from '@/lib/storage'
import type { LocalizedString, WikiPage } from '@/types'

export interface WikiPageSearchResult {
  id: string
  title: LocalizedString
  snippet: string
}

export function searchWikiPages(
  workspaceId: string,
  query: string,
): Promise<WikiPageSearchResult[]> {
  return apiRequest<WikiPageSearchResult[]>(
    `/wiki-pages/search?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`,
  )
}

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
