import { apiRequest } from '@/lib/api-client'
import type { EtlFileStorage, EtlPipelineStorage, EtlRunHistoryStorage } from '@/lib/storage'
import type { EtlFile, EtlPipeline, EtlRunHistoryEntry } from '@/types'

const PIPE = '/etl-pipelines'
const FILE = '/etl-files'
const RUN = '/etl-runs'

/** Server-mode ETL pipeline storage (workspace-scoped metadata + DAG config). */
export const apiEtlPipelineStorage: EtlPipelineStorage = {
  getAll: () => apiRequest<EtlPipeline[]>(PIPE),

  getByWorkspace: (workspaceId) =>
    apiRequest<EtlPipeline[]>(`${PIPE}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<EtlPipeline>(`${PIPE}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (pipeline) => {
    await apiRequest(PIPE, { method: 'POST', body: JSON.stringify(pipeline) })
  },

  update: async (id, changes) => {
    await apiRequest(`${PIPE}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${PIPE}/${id}`, { method: 'DELETE' })
  },
}

/** Server-mode ETL file storage (a pipeline's script tree, content inline). */
export const apiEtlFileStorage: EtlFileStorage = {
  getByPipeline: (pipelineId) =>
    apiRequest<EtlFile[]>(`${PIPE}/${pipelineId}/files`),

  getById: async (id) => {
    // No single-file GET endpoint; callers resolve files via getByPipeline.
    void id
    return undefined
  },

  create: async (file) => {
    await apiRequest(FILE, { method: 'POST', body: JSON.stringify(file) })
  },

  update: async (id, changes) => {
    await apiRequest(`${FILE}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`${FILE}/${id}`, { method: 'DELETE' })
  },

  deleteByPipeline: async (pipelineId) => {
    await apiRequest(`${PIPE}/${pipelineId}/files`, { method: 'DELETE' })
  },
}

/** Server-mode ETL run history: one row per pipeline run, per-script logs inline. */
export const apiEtlRunHistoryStorage: EtlRunHistoryStorage = {
  getByPipeline: (pipelineId) =>
    apiRequest<EtlRunHistoryEntry[]>(`${PIPE}/${pipelineId}/runs`),

  // POST is an upsert server-side (same run id as the run progresses), so there is
  // no separate create/update to choose between here.
  save: async (entry) => {
    await apiRequest(RUN, { method: 'POST', body: JSON.stringify(entry) })
  },

  delete: async (id) => {
    await apiRequest(`${RUN}/${id}`, { method: 'DELETE' })
  },

  deleteByPipeline: async (pipelineId) => {
    await apiRequest(`${PIPE}/${pipelineId}/runs`, { method: 'DELETE' })
  },
}
