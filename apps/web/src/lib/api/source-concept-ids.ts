import { apiRequest } from '@/lib/api-client'
import type {
  SourceConceptIdEntryStorage,
  SourceConceptIdRangeStorage,
} from '@/lib/storage'
import type { SourceConceptIdEntry, SourceConceptIdRange } from '@/types'

const RANGES = '/source-concept-id-ranges'
const ENTRIES = '/source-concept-id-entries'
const enc = encodeURIComponent

/** Server-mode range storage — composite key (workspaceId, badgeLabel), upsert via PUT. */
export const apiSourceConceptIdRangeStorage: SourceConceptIdRangeStorage = {
  getByWorkspace: (workspaceId) =>
    apiRequest<SourceConceptIdRange[]>(`${RANGES}?workspaceId=${enc(workspaceId)}`),

  get: async (workspaceId, badgeLabel) => {
    try {
      return await apiRequest<SourceConceptIdRange>(`${RANGES}/${enc(workspaceId)}/${enc(badgeLabel)}`)
    } catch {
      return undefined
    }
  },

  save: async (range) => {
    await apiRequest(RANGES, { method: 'PUT', body: JSON.stringify(range) })
  },

  delete: async (workspaceId, badgeLabel) => {
    await apiRequest(`${RANGES}/${enc(workspaceId)}/${enc(badgeLabel)}`, { method: 'DELETE' })
  },

  deleteByWorkspace: async (workspaceId) => {
    await apiRequest(`${RANGES}?workspaceId=${enc(workspaceId)}`, { method: 'DELETE' })
  },
}

/** Server-mode entry storage — composite string id, upsert (single + batch) via PUT. */
export const apiSourceConceptIdEntryStorage: SourceConceptIdEntryStorage = {
  getByWorkspace: (workspaceId) =>
    apiRequest<SourceConceptIdEntry[]>(`${ENTRIES}?workspaceId=${enc(workspaceId)}`),

  getByWorkspaceAndBadge: (workspaceId, badgeLabel) =>
    apiRequest<SourceConceptIdEntry[]>(
      `${ENTRIES}?workspaceId=${enc(workspaceId)}&badgeLabel=${enc(badgeLabel)}`,
    ),

  get: async (id) => {
    // No single-entry GET endpoint; callers resolve entries via the list methods.
    void id
    return undefined
  },

  save: async (entry) => {
    await apiRequest(ENTRIES, { method: 'PUT', body: JSON.stringify(entry) })
  },

  saveBatch: async (entries) => {
    await apiRequest(`${ENTRIES}/batch`, { method: 'PUT', body: JSON.stringify({ entries }) })
  },

  deleteByWorkspaceAndBadge: async (workspaceId, badgeLabel) => {
    await apiRequest(
      `${ENTRIES}?workspaceId=${enc(workspaceId)}&badgeLabel=${enc(badgeLabel)}`,
      { method: 'DELETE' },
    )
  },

  deleteByWorkspace: async (workspaceId) => {
    await apiRequest(`${ENTRIES}?workspaceId=${enc(workspaceId)}`, { method: 'DELETE' })
  },
}
