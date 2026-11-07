import { apiFetchFollowing, apiRequest } from '@/lib/api-client'
import type { ProjectStorage } from '@/lib/storage'
import type { Project } from '@/types'

/** Fetch the server-built project export ZIP (git-variant tree). In server mode
 * the browser triggers + downloads instead of assembling the ZIP from data it
 * would otherwise have to pull down (offloads the browser). Returns null on error
 * so the caller can fall back to the client builder. */
export async function fetchProjectExportZipFromServer(
  uid: string,
): Promise<Blob | null> {
  const res = await apiFetchFollowing(`/api/v1/projects/${encodeURIComponent(uid)}/export-zip`)
  if (!res.ok) return null
  return await res.blob()
}

/**
 * Server-mode implementation of ProjectStorage backed by the FastAPI API.
 * Projects are keyed by uid; responses are already camelCase.
 */
export const apiProjectStorage: ProjectStorage = {
  getAll: () => apiRequest<Project[]>('/projects'),

  getById: async (uid) => {
    try {
      return await apiRequest<Project>(`/projects/${encodeURIComponent(uid)}`)
    } catch {
      return undefined
    }
  },

  create: async (project) => {
    await apiRequest('/projects', {
      method: 'POST',
      body: JSON.stringify(project),
    })
  },

  update: async (uid, changes) => {
    await apiRequest(`/projects/${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  setFolderBindings: async (uid, bindings) => {
    await apiRequest(`/projects/${encodeURIComponent(uid)}/folder-bindings`, {
      method: 'PATCH',
      body: JSON.stringify(bindings),
    })
  },

  delete: async (uid) => {
    await apiRequest(`/projects/${encodeURIComponent(uid)}`, { method: 'DELETE' })
  },
}
