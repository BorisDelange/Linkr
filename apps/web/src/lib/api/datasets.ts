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

/** One column filter in a server row query — mirrors ColumnFilterInput's shapes. */
export interface ServerRowFilter {
  colId: string
  value?: string
  min?: number
  max?: number
  from?: string
  to?: string
}

export interface ServerRowsQuery {
  offset: number
  limit: number
  sort?: { colId: string; dir: 'asc' | 'desc' }
  filters?: ServerRowFilter[]
  na?: { colId: string; mode: 'exclude' | 'only' }[]
}

export interface ServerRowsPage {
  rows: Record<string, unknown>[]
  total: number
}

/**
 * Fetch one filtered/sorted/paginated page of dataset rows, computed server-side
 * on the Parquet. The server-mode counterpart to DatasetTable's in-memory work —
 * the browser never holds the whole dataset.
 */
export function queryDatasetRows(
  datasetFileId: string,
  query: ServerRowsQuery,
): Promise<ServerRowsPage> {
  return apiRequest<ServerRowsPage>(`/datasets/${datasetFileId}/rows/query`, {
    method: 'POST',
    body: JSON.stringify(query),
  })
}

/** Re-parse a dataset's stored raw file with new options, server-side. Returns
 *  the updated file (columns/rowCount recomputed by DuckDB, parity with import). */
export function reimportDataset(
  datasetFileId: string,
  parseOptions?: DatasetParseOptions,
): Promise<DatasetFile> {
  return apiRequest<DatasetFile>(`/datasets/${datasetFileId}/reimport`, {
    method: 'POST',
    body: JSON.stringify({ parseOptions: parseOptions ?? null }),
  })
}

/** Duplicate a dataset file server-side. The blob store is content-addressed, so
 *  the copy re-points the same rows/raw blobs — no bytes are copied. Returns the
 *  created file (with fresh id) to insert into the store. */
export function duplicateDataset(datasetFileId: string, name: string): Promise<DatasetFile> {
  return apiRequest<DatasetFile>(`/datasets/${datasetFileId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/** Aggregate stats for one column: completeness + distinct, plus a shape-specific
 *  payload (numeric quartiles/histogram, date min/max/timeline, or category counts).
 *  All binning happens server-side; the browser gets ~15 bins, never raw values. */
export function fetchColumnStats(
  datasetFileId: string,
  colId: string,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    `/datasets/${datasetFileId}/columns/${encodeURIComponent(colId)}/stats`,
  )
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
