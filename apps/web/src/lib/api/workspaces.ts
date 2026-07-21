import { apiFetch, apiRequest } from '@/lib/api-client'
import type { WorkspaceStorage } from '@/lib/storage'
import type { Workspace } from '@/types'
import type { BuildWorkspaceZipOptions } from '@/lib/entity-io'

/** Fetch the server-built workspace export ZIP (git-variant tree). In server mode
 * the browser triggers + downloads instead of assembling the ZIP from data it
 * would otherwise have to pull down (offloads the browser). The export dialog's
 * section / per-entity data / exclude / credentials toggles are forwarded as a JSON
 * body. Returns null on error so the caller can fall back to the client builder. */
export async function fetchWorkspaceExportZipFromServer(
  workspaceId: string,
  options: BuildWorkspaceZipOptions = {},
): Promise<Blob | null> {
  const res = await apiFetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/export-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sections: options.sections ?? {},
      includeEntityData: options.includeEntityData ?? {},
      excludeEntities: options.excludeEntities ?? {},
      includeCredentials: options.includeCredentials ?? false,
    }),
  })
  if (!res.ok) return null
  return await res.blob()
}

/**
 * Server-mode implementation of WorkspaceStorage backed by the FastAPI API.
 * Responses are already camelCase, so they match the Workspace type directly.
 */
export const apiWorkspaceStorage: WorkspaceStorage = {
  getAll: () => apiRequest<Workspace[]>('/workspaces'),

  getById: async (id) => {
    try {
      return await apiRequest<Workspace>(`/workspaces/${id}`)
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
    await apiRequest(`/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/workspaces/${id}`, { method: 'DELETE' })
  },
}
