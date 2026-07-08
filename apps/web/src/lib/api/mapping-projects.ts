import { apiFetch, apiRequest } from '@/lib/api-client'
import { uploadFileInChunks } from '@/lib/api/upload'
import type {
  ConceptMappingStorage,
  MappingProjectStorage,
  ServiceMappingStorage,
} from '@/lib/storage'
import type { ConceptMapping, MappingProject, ServiceMapping } from '@/types'

const PROJ = '/mapping-projects'
const MAP = '/concept-mappings'
const SVC = '/service-mappings'

/**
 * Strip the heavy raw CSV bytes out of a project before it goes over JSON: they
 * live in the content-addressed blob store, referenced by sha. If a project
 * carries a fresh `rawFileBuffer`.
 */

/** Whether this project has fresh CSV bytes that must be offloaded to the blob store. */
function hasRawBuffer(project: Partial<MappingProject>): boolean {
  return !!project.fileSourceData?.rawFileBuffer?.byteLength
}

/** Project metadata with the CSV bytes removed (rows stays empty — legacy only). */
function stripBuffer<T extends Partial<MappingProject>>(project: T): T {
  const fsd = project.fileSourceData
  if (!fsd) return project
  return { ...project, fileSourceData: { ...fsd, rawFileBuffer: undefined, rows: [] } }
}

/** Upload the CSV bytes to the blob store and attach the sha to the project.
 * The project must already exist server-side (raw-file 404s otherwise). */
async function uploadRawFile(projectId: string, project: Partial<MappingProject>): Promise<void> {
  const fsd = project.fileSourceData
  const buffer = fsd?.rawFileBuffer
  if (!fsd || !buffer || buffer.byteLength === 0) return
  const blob = new Blob([buffer as unknown as BlobPart], { type: 'text/csv' })
  const fileName = fsd.fileName || 'source.csv'
  const { sha } = await uploadFileInChunks(blob, fileName)
  await apiRequest(`${PROJ}/${projectId}/raw-file`, {
    method: 'POST',
    body: JSON.stringify({ sha, fileName }),
  })
}

/** Fetch the source CSV bytes for a project and rebuild `fileSourceData.rawFileBuffer`. */
async function loadRawFile(project: MappingProject): Promise<MappingProject> {
  if (project.sourceType !== 'file' || !project.fileSourceData) return project
  try {
    const res = await apiFetch(`/api/v1${PROJ}/${project.id}/raw-file`)
    if (!res.ok) return project
    const buf = new Uint8Array(await res.arrayBuffer())
    return { ...project, fileSourceData: { ...project.fileSourceData, rawFileBuffer: buf } }
  } catch {
    return project
  }
}

export const apiMappingProjectStorage: MappingProjectStorage = {
  // Lazy: list responses omit the CSV bytes; they're loaded on getById.
  getAll: () => apiRequest<MappingProject[]>(PROJ),

  getByWorkspace: (workspaceId) =>
    apiRequest<MappingProject[]>(`${PROJ}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      const project = await apiRequest<MappingProject>(`${PROJ}/${id}`)
      return await loadRawFile(project)
    } catch {
      return undefined
    }
  },

  create: async (project) => {
    // Create the row first (metadata, no bytes), THEN upload the CSV — the
    // raw-file endpoint needs the project to exist.
    await apiRequest(PROJ, { method: 'POST', body: JSON.stringify(stripBuffer(project)) })
    if (hasRawBuffer(project)) await uploadRawFile(project.id, project)
  },

  update: async (id, changes) => {
    await apiRequest(`${PROJ}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(stripBuffer(changes)),
    })
    if (hasRawBuffer(changes)) await uploadRawFile(id, changes)
  },

  delete: async (id) => {
    await apiRequest(`${PROJ}/${id}`, { method: 'DELETE' })
  },
}

export const apiConceptMappingStorage: ConceptMappingStorage = {
  getByProject: (projectId) =>
    apiRequest<ConceptMapping[]>(`${PROJ}/${projectId}/mappings`),

  getById: async (id) => {
    void id
    return undefined
  },

  create: async (mapping) => {
    await apiRequest(MAP, { method: 'POST', body: JSON.stringify(mapping) })
  },

  createBatch: async (mappings) => {
    if (mappings.length === 0) return
    await apiRequest(`${MAP}/batch`, { method: 'POST', body: JSON.stringify({ mappings }) })
  },

  update: async (id, changes) => {
    await apiRequest(`${MAP}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${MAP}/${id}`, { method: 'DELETE' })
  },

  deleteByProject: async (projectId) => {
    await apiRequest(`${PROJ}/${projectId}/mappings`, { method: 'DELETE' })
  },

  deleteByProjectIds: async (projectIds) => {
    if (projectIds.length === 0) return 0
    await apiRequest(`${MAP}/delete-by-projects`, {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    })
    return 0
  },

  deleteOrphans: async (validProjectIds) => {
    await apiRequest(`${MAP}/delete-orphans`, {
      method: 'POST',
      body: JSON.stringify({ validProjectIds: [...validProjectIds] }),
    }).catch(() => {})
    return 0
  },
}

export const apiServiceMappingStorage: ServiceMappingStorage = {
  getAll: () => apiRequest<ServiceMapping[]>(SVC),

  getByWorkspace: (workspaceId) =>
    apiRequest<ServiceMapping[]>(`${SVC}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<ServiceMapping>(`${SVC}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (mapping) => {
    await apiRequest(SVC, { method: 'POST', body: JSON.stringify(mapping) })
  },

  update: async (id, changes) => {
    await apiRequest(`${SVC}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${SVC}/${id}`, { method: 'DELETE' })
  },
}
