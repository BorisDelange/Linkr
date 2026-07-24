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

// Datasets are disk-source-of-truth in server mode (projects/<uid>/datasets/).
// The backend addresses them by relative PATH; to fit the store's id-keyed
// interfaces we make server-mode DatasetFile.id === the relative path. This cache
// maps id(=path) → projectUid so id-only methods (rows/stats/analyses) can build
// the project-scoped API calls. Rebuilt on every getByProject scan.
const _dsProject = new Map<string, string>()

/** A dataset node from the disk scan (id derives from the relative path). */
interface DsNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  path: string
  columns?: { id: string; name: string; type: string; order?: number }[] | null
  rowCount?: number | null
}

function dsNodeToFile(projectUid: string, n: DsNode): DatasetFile {
  // Disk-source identity: the id IS the relative path, so every opaque consumer
  // (rows/stats query, analyses, /execute) sends the path the backend expects.
  _dsProject.set(n.path, projectUid)
  const parentPath = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : null
  return {
    id: n.path,
    projectUid,
    name: n.name,
    type: n.type,
    parentId: parentPath,
    path: n.path,
    columns: (n.columns ?? undefined) as DatasetFile['columns'],
    rowCount: n.rowCount ?? undefined,
    createdAt: '',
    updatedAt: '',
  }
}

/** Child path from parent id(=path) + name (root parent → bare name). */
function dsChildPath(parentId: string | null, name: string): string {
  return parentId ? `${parentId}/${name}` : name
}

/**
 * Server-mode dataset import: upload the raw file in chunks, then land it in
 * projects/<uid>/datasets/<path> on disk (the source of truth) and parse it into
 * the Parquet cache. Returns the created node (id === its relative path).
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
  // The dataset keeps its real filename on disk; parentId (a path) prefixes it.
  const path = dsChildPath(params.parentId, params.fileName)
  const node = await apiRequest<DsNode>('/dataset-files/import', {
    method: 'POST',
    body: JSON.stringify({ projectUid: params.projectUid, path, sha: uploaded.sha }),
  })
  return dsNodeToFile(params.projectUid, node)
}

/** A parsed column as returned by the server preview/import (id derives from name). */
export interface ServerParsedColumn {
  id: string
  name: string
  type: string
  order?: number
}

export interface ServerPreview {
  columns: ServerParsedColumn[]
  preview: Record<string, unknown>[]
  rowCount: number
  sheetNames?: string[] | null
  /** The uploaded blob's content hash, reused at import so it isn't re-uploaded. */
  sha: string
}

/**
 * Server-mode preview: upload the raw file once, then parse it server-side
 * (same DuckDB parser the import uses) WITHOUT persisting — so the previewed
 * columns/types/rowCount are exactly what the import will store. Returns the sha
 * so the caller reuses the already-uploaded blob at import time.
 */
export async function previewDatasetOnServer(params: {
  projectUid: string
  file: Blob
  fileName: string
  parseOptions?: DatasetParseOptions
  onProgress?: (fraction: number) => void
}): Promise<ServerPreview> {
  const { sha } = await uploadFileInChunks(params.file, params.fileName, params.onProgress)
  const res = await apiRequest<Omit<ServerPreview, 'sha'>>('/dataset-files/preview', {
    method: 'POST',
    body: JSON.stringify({
      projectUid: params.projectUid,
      sha,
      fileName: params.fileName,
      parseOptions: params.parseOptions ?? null,
    }),
  })
  return { ...res, sha }
}

/**
 * Re-preview a blob already uploaded (by sha) with new parse options, WITHOUT
 * re-uploading — the option-tweak path for the upload dialog. Same `/preview`
 * endpoint as previewDatasetOnServer, minus the chunked upload.
 */
export async function previewDatasetBySha(params: {
  projectUid: string
  sha: string
  fileName: string
  parseOptions?: DatasetParseOptions
}): Promise<ServerPreview> {
  const res = await apiRequest<Omit<ServerPreview, 'sha'>>('/dataset-files/preview', {
    method: 'POST',
    body: JSON.stringify({
      projectUid: params.projectUid,
      sha: params.sha,
      fileName: params.fileName,
      parseOptions: params.parseOptions ?? null,
    }),
  })
  return { ...res, sha: params.sha }
}

/**
 * Import a blob already uploaded during preview, referenced by its sha — no
 * re-upload. Lands it in datasets/<path> and parses it into the Parquet cache.
 */
export async function importDatasetBySha(params: {
  projectUid: string
  name: string
  parentId: string | null
  sha: string
  fileName: string
  parseOptions?: DatasetParseOptions
}): Promise<DatasetFile> {
  const path = dsChildPath(params.parentId, params.fileName)
  const node = await apiRequest<DsNode>('/dataset-files/import', {
    method: 'POST',
    body: JSON.stringify({
      projectUid: params.projectUid,
      path,
      sha: params.sha,
      parseOptions: params.parseOptions ?? null,
    }),
  })
  return dsNodeToFile(params.projectUid, node)
}

/**
 * Preview an already-imported dataset re-parsed with new options, WITHOUT
 * persisting — the Import Settings dialog's server-mode counterpart. Reads the
 * server's existing raw file (no upload), so the user sees the effect of changed
 * options before committing a reimport.
 */
export function previewDatasetByPath(
  datasetFileId: string,
  parseOptions?: DatasetParseOptions,
): Promise<Omit<ServerPreview, 'sha'>> {
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  return apiRequest<Omit<ServerPreview, 'sha'>>('/dataset-files/preview-path', {
    method: 'POST',
    body: JSON.stringify({ projectUid, path: datasetFileId, parseOptions: parseOptions ?? null }),
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
  /** Categorical multi-select: match any of these values (by string form). */
  values?: string[]
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
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  const qs = `projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(datasetFileId)}`
  return apiRequest<ServerRowsPage>(`/dataset-files/rows/query?${qs}`, {
    method: 'POST',
    body: JSON.stringify(query),
  })
}

/**
 * Resolve one dataset file's columns + rowCount on demand (the lazy counterpart
 * to the meta-free listing). Called when a file is opened, so the list itself
 * stays instant no matter how large the datasets are.
 */
export async function fetchDatasetMeta(datasetFileId: string): Promise<DatasetFile> {
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  const qs = `projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(datasetFileId)}`
  const node = await apiRequest<DsNode>(`/dataset-files/meta?${qs}`)
  return dsNodeToFile(projectUid, node)
}

/** Re-parse a dataset's raw file with new options (rebuilds the Parquet cache). */
export async function reimportDataset(
  datasetFileId: string,
  parseOptions?: DatasetParseOptions,
): Promise<DatasetFile> {
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  const node = await apiRequest<DsNode>('/dataset-files/reimport', {
    method: 'POST',
    body: JSON.stringify({ projectUid, path: datasetFileId, parseOptions: parseOptions ?? null }),
  })
  return dsNodeToFile(projectUid, node)
}

/** Duplicate a dataset by copying its raw file to a sibling with a new name. */
export async function duplicateDataset(datasetFileId: string, name: string): Promise<DatasetFile> {
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  const node = await apiRequest<DsNode>('/dataset-files/duplicate', {
    method: 'POST',
    body: JSON.stringify({ projectUid, path: datasetFileId, newName: name }),
  })
  return dsNodeToFile(projectUid, node)
}

/** Aggregate stats for one column: completeness + distinct, plus a shape-specific
 *  payload (numeric quartiles/histogram, date min/max/timeline, or category counts).
 *  All binning happens server-side; the browser gets ~15 bins, never raw values. */
export function fetchColumnStats(
  datasetFileId: string,
  colId: string,
): Promise<Record<string, unknown>> {
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  const qs = `projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(datasetFileId)}`
  return apiRequest<Record<string, unknown>>(
    `/dataset-files/columns/${encodeURIComponent(colId)}/stats?${qs}`,
  )
}

/** Distinct values of a column (alphabetical, up to `limit`, optional case-insensitive
 *  search) for a filter dropdown — server-side SELECT DISTINCT, no raw rows shipped. */
export function fetchColumnDistinct(
  datasetFileId: string,
  colId: string,
  opts?: { limit?: number; search?: string },
): Promise<{ values: string[]; truncated: boolean }> {
  const projectUid = _dsProject.get(datasetFileId) ?? ''
  let qs = `projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(datasetFileId)}`
  if (opts?.limit) qs += `&limit=${opts.limit}`
  if (opts?.search) qs += `&search=${encodeURIComponent(opts.search)}`
  return apiRequest<{ values: string[]; truncated: boolean }>(
    `/dataset-files/columns/${encodeURIComponent(colId)}/distinct?${qs}`,
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
  getByProject: async (projectUid) => {
    const nodes = await apiRequest<DsNode[]>(
      `/dataset-files?projectUid=${encodeURIComponent(projectUid)}`,
    )
    return nodes.map((n) => dsNodeToFile(projectUid, n))
  },

  getById: async () => undefined, // callers hold the tree from getByProject

  create: async (file) => {
    // Only folders are created via this path (files arrive through import). id=path.
    if (file.type !== 'folder') return
    const path = dsChildPath(file.parentId, file.name)
    _dsProject.set(path, file.projectUid)
    await apiRequest('/dataset-files/folder', {
      method: 'POST',
      body: JSON.stringify({ projectUid: file.projectUid, path }),
    })
  },

  update: async (id, changes) => {
    const projectUid = _dsProject.get(id) ?? ''
    if (changes.name !== undefined) {
      const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''
      const newPath = parent ? `${parent}/${changes.name}` : changes.name
      await apiRequest('/dataset-files/move', {
        method: 'POST',
        body: JSON.stringify({ projectUid, path: id, newPath }),
      })
    }
    if (changes.parentId !== undefined) {
      const name = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
      const newPath = dsChildPath(changes.parentId ?? null, name)
      await apiRequest('/dataset-files/move', {
        method: 'POST',
        body: JSON.stringify({ projectUid, path: id, newPath }),
      })
    }
  },

  delete: async (id) => {
    const projectUid = _dsProject.get(id) ?? ''
    await apiRequest('/dataset-files/delete', {
      method: 'POST',
      body: JSON.stringify({ projectUid, path: id }),
    })
  },

  deleteByProject: async () => {
    // The project dir is removed with the project on the server; no-op here.
  },
}

export const apiDatasetDataStorage: DatasetDataStorage = {
  // Server datasets paginate via queryDatasetRows; the whole-rows blob is unused.
  get: async () => undefined,
  save: async (_data: DatasetData) => {},
  delete: async (_datasetFileId) => {},
}

export const apiDatasetRawFileStorage: DatasetRawFileStorage = {
  get: async (datasetFileId) => {
    // The raw file lives on disk under datasets/<path>; download it by path.
    const projectUid = _dsProject.get(datasetFileId) ?? ''
    try {
      const qs = `projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(datasetFileId)}`
      const res = await apiFetch(`/api/v1/dataset-files/raw?${qs}`)
      if (!res.ok) return undefined
      const blob = await res.blob()
      const fileName = res.headers.get('x-file-name') ?? ''
      return { datasetFileId, blob, fileName }
    } catch {
      return undefined
    }
  },
  save: async (_data: DatasetRawFile) => {},
  delete: async (_datasetFileId) => {},
}

export const apiDatasetAnalysisStorage: DatasetAnalysisStorage = {
  getByDataset: async (datasetFileId) => {
    const projectUid = _dsProject.get(datasetFileId) ?? ''
    const qs = `projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(datasetFileId)}`
    const rows = await apiRequest<(DatasetAnalysis & { datasetPath: string })[]>(
      `/dataset-files/analyses?${qs}`,
    )
    // Server keys analyses by datasetPath; the store links them by datasetFileId (= path).
    return rows.map((a) => ({ ...a, datasetFileId: a.datasetPath }))
  },

  getById: async () => undefined,

  create: async (analysis) => {
    const projectUid = _dsProject.get(analysis.datasetFileId) ?? ''
    await apiRequest('/dataset-files/analyses', {
      method: 'POST',
      body: JSON.stringify({
        id: analysis.id,
        projectUid,
        datasetPath: analysis.datasetFileId,
        name: analysis.name,
        type: analysis.type,
        config: analysis.config,
      }),
    })
  },

  update: async (id, changes) => {
    await apiRequest(`/dataset-files/analyses/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })
  },

  delete: async (id) => {
    await apiRequest(`/dataset-files/analyses/${id}`, { method: 'DELETE' })
  },

  deleteByDataset: async () => {
    // Analyses reconcile against the disk scan on the server.
  },
}
