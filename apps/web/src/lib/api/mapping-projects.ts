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
 * carries a fresh `rawFileBuffer`, upload it first and record the sha.
 */
async function persistRawFile(project: MappingProject): Promise<MappingProject> {
  const fsd = project.fileSourceData
  const buffer = fsd?.rawFileBuffer
  if (!fsd || !buffer || buffer.byteLength === 0) return project

  const blob = new Blob([buffer as unknown as BlobPart], { type: 'text/csv' })
  const fileName = fsd.fileName || 'source.csv'
  const { sha } = await uploadFileInChunks(blob, fileName)
  await apiRequest(`${PROJ}/${project.id}/raw-file`, {
    method: 'POST',
    body: JSON.stringify({ sha, fileName }),
  })
  // Send project metadata without the bytes (rows stays empty — legacy only).
  return {
    ...project,
    fileSourceData: { ...fsd, rawFileBuffer: undefined, rows: [] },
  }
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
    const withoutBuffer = await persistRawFile(project)
    await apiRequest(PROJ, { method: 'POST', body: JSON.stringify(withoutBuffer) })
  },

  update: async (id, changes) => {
    // If an update carries a new buffer, upload it and drop the bytes from JSON.
    let payload: Partial<MappingProject> = changes
    if (changes.fileSourceData?.rawFileBuffer?.byteLength) {
      const persisted = await persistRawFile({ id, ...changes } as MappingProject)
      payload = { ...changes, fileSourceData: persisted.fileSourceData }
    }
    await apiRequest(`${PROJ}/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
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
