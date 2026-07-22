import { apiFetch, apiRequest } from '@/lib/api-client'
import { uploadFileInChunks } from '@/lib/api/upload'
import type { DataSourceStorage, FileStorage } from '@/lib/storage'
import type { DataSource, StoredFile } from '@/types'

/** Server-side schema introspection result — mirrors engine.IntrospectedTable[]. */
export interface IntrospectedColumn {
  name: string
  type: string
  nullable: boolean
}
export interface IntrospectedTable {
  name: string
  columns: IntrospectedColumn[]
}
export interface TestConnectionResult {
  ok: boolean
  error?: string
  tables: IntrospectedTable[]
}

/**
 * Test an external database connection server-side. The password stays in this
 * request only — the backend opens the connection, introspects the schema, and
 * never persists the credential. Used for Postgres (and other server-run engines).
 */
export function testConnectionOnServer(
  connectionConfig: Record<string, unknown>,
): Promise<TestConnectionResult> {
  return apiRequest<TestConnectionResult>('/data-sources/test-connection', {
    method: 'POST',
    body: JSON.stringify({ connectionConfig }),
  })
}

/**
 * Run read-only SQL against an external source server-side and return the rows.
 * The server-mode counterpart to engine.queryDataSource — the raw tables never
 * reach the browser, only the result rows.
 */
export async function queryDataSourceOnServer(
  dataSourceId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const res = await apiRequest<{ rows: Record<string, unknown>[] }>(
    `/data-sources/${dataSourceId}/query`,
    { method: 'POST', body: JSON.stringify({ sql }) },
  )
  return res.rows
}

/** Register an already-uploaded blob (by sha) as a file of a data source. */
export function registerDataSourceFile(
  dataSourceId: string,
  sha: string,
  fileName: string,
  fileSize: number,
): Promise<void> {
  return apiRequest('/data-sources/files/import', {
    method: 'POST',
    body: JSON.stringify({ dataSourceId, sha, fileName, fileSize }),
  }).then(() => undefined)
}

/**
 * Upload a File (streamed in chunks) and register it as a data source file.
 * Streaming the File avoids reading it fully into an ArrayBuffer — required for
 * files over 2 GB, which the Blob/ArrayBuffer path cannot hold.
 */
export async function uploadDataSourceFile(
  dataSourceId: string,
  file: File,
  fileName: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const uploaded = await uploadFileInChunks(file, fileName, onProgress)
  await registerDataSourceFile(dataSourceId, uploaded.sha, fileName, file.size)
}

/**
 * Re-validate a stored external source using its saved (encrypted) credentials —
 * no password sent from the browser. Returns ok + introspected tables.
 */
export function retestConnectionOnServer(
  dataSourceId: string,
): Promise<TestConnectionResult> {
  return apiRequest<TestConnectionResult>(`/data-sources/${dataSourceId}/retest`, {
    method: 'POST',
  })
}

/**
 * Introspect a stored external source's schema (tables + columns) server-side.
 * Uses the dedicated introspection path (native Postgres catalog), not the
 * generic SQL executor — so it returns the source's real tables.
 */
export function fetchDataSourceSchema(
  dataSourceId: string,
): Promise<IntrospectedTable[]> {
  return apiRequest<IntrospectedTable[]>(`/data-sources/${dataSourceId}/schema`)
}

/**
 * Server-mode data source storage. Metadata is CRUD against the API; the
 * connection password is stripped server-side and never returned.
 */
export const apiDataSourceStorage: DataSourceStorage = {
  getAll: () => apiRequest<DataSource[]>('/data-sources'),

  getByWorkspace: (workspaceId) =>
    apiRequest<DataSource[]>(`/data-sources?workspaceId=${encodeURIComponent(workspaceId)}`),

  // Project↔source links live in Project.linkedDataSourceIds (client-side), so
  // there is no server-side project filter — callers use the store's filtered
  // getProjectSources() instead. Kept for interface parity.
  getByProject: async () => [],

  getById: async (id) => {
    try {
      return await apiRequest<DataSource>(`/data-sources/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (dataSource) => {
    await apiRequest('/data-sources', { method: 'POST', body: JSON.stringify(dataSource) })
  },

  update: async (id, changes) => {
    await apiRequest(`/data-sources/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  },

  delete: async (id) => {
    await apiRequest(`/data-sources/${id}`, { method: 'DELETE' })
  },
}

/** Metadata shape returned by the file list/import endpoints. */
interface FileMeta {
  id: string
  dataSourceId: string
  fileName: string
  fileSize: number
  contentHash: string
  createdAt: string
}

async function fetchBlob(fileId: string): Promise<ArrayBuffer> {
  const res = await apiFetch(`/api/v1/data-sources/files/${fileId}/blob`)
  if (!res.ok) throw new Error(`blob fetch failed (${res.status})`)
  return res.arrayBuffer()
}

/**
 * Reconstruct a StoredFile (with its raw bytes) from server metadata.
 *
 * The bytes are downloaded because the browser DuckDB-WASM mount path still
 * needs them (registerFileBuffer). This transfer disappears once the server-side
 * query engine lands (see docs/architecture.md, "Fullstack Storage & Compute"): reading the tables will
 * then happen on the server and getByDataSource will no longer ship bytes.
 */
async function toStoredFile(meta: FileMeta): Promise<StoredFile> {
  return {
    id: meta.id,
    dataSourceId: meta.dataSourceId,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    data: await fetchBlob(meta.id),
    createdAt: meta.createdAt,
    contentHash: meta.contentHash,
  }
}

/**
 * Server-mode file storage. Bytes live in the content-addressed blob store
 * (deduplicated by sha256 — the server's equivalent of the client's dedupRef).
 */
export const apiFileStorage: FileStorage = {
  getByDataSource: async (dataSourceId) => {
    const metas = await apiRequest<FileMeta[]>(`/data-sources/${dataSourceId}/files`)
    return Promise.all(metas.map(toStoredFile))
  },

  getById: async (id) => {
    // No single-file metadata endpoint; the blob carries the filename header.
    try {
      const res = await apiFetch(`/api/v1/data-sources/files/${id}/blob`)
      if (!res.ok) return undefined
      const data = await res.arrayBuffer()
      return {
        id,
        dataSourceId: '',
        fileName: res.headers.get('x-file-name') ?? `${id}.data`,
        fileSize: data.byteLength,
        data,
        createdAt: new Date().toISOString(),
      }
    } catch {
      return undefined
    }
  },

  create: async (file) => {
    // file.data is an in-memory ArrayBuffer; wrapping it in a Blob throws for
    // payloads > 2 GB. Callers with large files should use uploadDataSourceFile
    // (streams the File). This path stays for small, already-materialized blobs.
    const blob = new Blob([file.data])
    const uploaded = await uploadFileInChunks(blob, file.fileName)
    await registerDataSourceFile(file.dataSourceId, uploaded.sha, file.fileName, file.fileSize)
  },

  delete: async (id) => {
    await apiRequest(`/data-sources/files/${id}`, { method: 'DELETE' })
  },

  deleteByDataSource: async (dataSourceId) => {
    const metas = await apiRequest<FileMeta[]>(`/data-sources/${dataSourceId}/files`)
    await Promise.all(
      metas.map((m) => apiRequest(`/data-sources/files/${m.id}`, { method: 'DELETE' })),
    )
  },

  // Dedup is server-side by sha256, so there is no canonical-row lookup to do.
  findByHash: async () => undefined,
}
