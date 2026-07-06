import { apiFetch, apiRequest } from '@/lib/api-client'
import { uploadFileInChunks } from '@/lib/api/upload'
import type {
  DatasetAnalysisStorage,
  DatasetDataStorage,
  DatasetFileStorage,
  DatasetRawFileStorage,
} from '@/lib/storage'
import type {
  DatasetAnalysis,
  DatasetData,
  DatasetFile,
  DatasetParseOptions,
  DatasetRawFile,
} from '@/types'

/**
 * Server-mode dataset import: upload the raw file in chunks, then ask the
 * backend to parse it (DuckDB) and create the DatasetFile. Returns the created
 * file, whose columns/rowCount were computed server-side (parity with the
 * client parser). Used by UploadDatasetDialog instead of createFileWithData.
 */
export async function importDatasetOnServer(params: {
  projectUid: string
  name: string
  parentId: string | null
  file: Blob
  fileName: string
  parseOptions?: DatasetParseOptions
  onProgress?: (fraction: number) => void
}): Promise<DatasetFile> {
  const uploaded = await uploadFileInChunks(params.file, params.fileName, params.onProgress)
  return apiRequest<DatasetFile>('/datasets/import', {
    method: 'POST',
    body: JSON.stringify({
      projectUid: params.projectUid,
      name: params.name,
      parentId: params.parentId,
      sha: uploaded.sha,
      fileName: uploaded.fileName,
      parseOptions: params.parseOptions ?? null,
    }),
  })
}

/**
 * Server-mode dataset storage. Metadata (DatasetFile, DatasetAnalysis) is CRUD
 * against the API; heavy content (rows, raw file) is blob-backed on the server.
 *
 * Import is not done here — UploadDatasetDialog uploads the raw file in chunks
 * and calls POST /datasets/import, which parses server-side and creates the
 * DatasetFile. These adapters cover the remaining reads/writes the stores make.
 */

export const apiDatasetFileStorage: DatasetFileStorage = {
  getByProject: (projectUid) =>
    apiRequest<DatasetFile[]>(`/datasets?projectUid=${encodeURIComponent(projectUid)}`),

  getById: async (id) => {
    try {
      return await apiRequest<DatasetFile>(`/datasets/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (file) => {
    await apiRequest('/datasets', { method: 'POST', body: JSON.stringify(file) })
  },

  update: async (id, changes) => {
    await apiRequest(`/datasets/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`/datasets/${id}`, { method: 'DELETE' })
  },

  deleteByProject: async (projectUid) => {
    const files = await apiRequest<DatasetFile[]>(
      `/datasets?projectUid=${encodeURIComponent(projectUid)}`,
    )
    // Delete roots; the server cascades children by parent_id.
    const roots = files.filter((f) => !f.parentId)
    await Promise.all(roots.map((f) => apiRequest(`/datasets/${f.id}`, { method: 'DELETE' })))
  },
}

export const apiDatasetDataStorage: DatasetDataStorage = {
  get: async (datasetFileId) => {
    try {
      const res = await apiRequest<{ rows: Record<string, unknown>[] }>(
        `/datasets/${datasetFileId}/data`,
      )
      return { datasetFileId, rows: res.rows }
    } catch {
      return undefined
    }
  },

  save: async (data: DatasetData) => {
    await apiRequest(`/datasets/${data.datasetFileId}/data`, {
      method: 'PUT',
      body: JSON.stringify({ rows: data.rows }),
    })
  },

  delete: async (datasetFileId) => {
    // Rows are cleared by writing an empty set (blob is freed if unreferenced).
    await apiRequest(`/datasets/${datasetFileId}/data`, {
      method: 'PUT',
      body: JSON.stringify({ rows: [] }),
    })
  },
}

export const apiDatasetRawFileStorage: DatasetRawFileStorage = {
  get: async (datasetFileId) => {
    try {
      const res = await apiFetch(`/api/v1/datasets/${datasetFileId}/raw`)
      if (!res.ok) return undefined
      const blob = await res.blob()
      const fileName =
        res.headers.get('x-file-name') ?? `${datasetFileId}.data`
      return { datasetFileId, blob, fileName }
    } catch {
      return undefined
    }
  },

  // The raw file is stored by POST /datasets/import (chunked upload). In server
  // mode there is no separate raw-save step, so this is a no-op.
  save: async (_data: DatasetRawFile) => {},

  delete: async (_datasetFileId) => {},
}

export const apiDatasetAnalysisStorage: DatasetAnalysisStorage = {
  getByDataset: (datasetFileId) =>
    apiRequest<DatasetAnalysis[]>(`/datasets/${datasetFileId}/analyses`),

  getById: async () => undefined, // not needed by callers in server mode

  create: async (analysis) => {
    await apiRequest(`/datasets/${analysis.datasetFileId}/analyses`, {
      method: 'POST',
      body: JSON.stringify(analysis),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`/datasets/analyses/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/datasets/analyses/${id}`, { method: 'DELETE' })
  },

  deleteByDataset: async () => {
    // Analyses cascade with the dataset file on the server.
  },
}
