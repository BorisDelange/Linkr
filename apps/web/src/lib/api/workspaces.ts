import { apiFetchFollowing, apiRequest } from '@/lib/api-client'
import type { WorkspaceStorage } from '@/lib/storage'
import type { Workspace } from '@/types'
import type { BuildWorkspaceZipOptions } from '@/lib/entity-io'

/** Fetch the server-built workspace export ZIP (git-variant tree). In server mode
 * the browser triggers + downloads instead of assembling the ZIP from data it
 * would otherwise have to pull down (offloads the browser). The export dialog's
 * section / per-entity exclude toggles are forwarded as a JSON body. Returns null
 * on error so the caller can fall back to the client builder. `leftOutProjects`:
 * how many projects the caller may not read were left out, never which. */
export async function fetchWorkspaceExportZipFromServer(
  workspaceId: string,
  options: BuildWorkspaceZipOptions = {},
): Promise<{ blob: Blob; leftOutProjects: number } | null> {
  const res = await apiFetchFollowing(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/export-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sections: options.sections ?? {},
      excludeEntities: options.excludeEntities ?? {},
    }),
  })
  if (!res.ok) return null
  return {
    blob: await res.blob(),
    leftOutProjects: Number(res.headers.get('x-linkr-projects-left-out')) || 0,
  }
}

/**
 * Server-mode implementation of WorkspaceStorage backed by the FastAPI API.
 * Responses are already camelCase, so they match the Workspace type directly.
 */
export const apiWorkspaceStorage: WorkspaceStorage = {
  getAll: () => apiRequest<Workspace[]>('/workspaces'),

  getById: async (id) => {
    try {
      return await apiRequest<Workspace>(`/workspaces/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  create: async (workspace) => {
    await apiRequest('/workspaces', {
      method: 'POST',
      body: JSON.stringify(workspace),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}
