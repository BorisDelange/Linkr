import { apiRequest } from '@/lib/api-client'
import type { DataDictionaryStorage, DictionarySyncResult } from '@/lib/storage'
import type { DataDictionary } from '@/types'

const BASE = '/data-dictionaries'

/** Server-mode DataDictionaryStorage: the server applies the sync. */
export const apiDataDictionaryStorage: DataDictionaryStorage = {
  getByWorkspace: (workspaceId) =>
    apiRequest<DataDictionary[]>(`${BASE}?workspaceId=${encodeURIComponent(workspaceId)}`),

  create: async (dictionary) => {
    await apiRequest(BASE, { method: 'POST', body: JSON.stringify(dictionary) })
  },

  update: async (id, changes) => {
    await apiRequest(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${BASE}/${id}`, { method: 'DELETE' })
  },

  sync: (id, content) =>
    apiRequest<DictionarySyncResult>(`${BASE}/${id}/content`, {
      method: 'PUT',
      body: JSON.stringify({
        conceptSets: content.conceptSets,
        unitConversions: content.unitConversions,
        recommendedUnits: content.recommendedUnits,
        commit: content.commit,
      }),
    }),
}
