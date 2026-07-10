import { apiRequest } from '@/lib/api-client'
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

/** Run SQL over a file-source project's CSV server-side (DuckDB reads the blob).
 * The SQL references the `source_concepts` view, built server-side from the
 * project's columnMapping — mirroring the DuckDB-WASM mount. */
export function queryFileSourceOnServer(
  projectId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  return apiRequest<Record<string, unknown>[]>(`${PROJ}/${projectId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  })
}

/** Upload a file and get its columns + row count server-side, before the project
 * exists — for previewing a file whose headers can't be read in the browser
 * (Parquet in server mode). Returns the sha so the caller can reuse the blob at
 * create time instead of re-uploading. */
export async function previewFileColumnsOnServer(
  file: Blob,
  fileName: string,
  parseOptions?: Record<string, unknown>,
): Promise<{ columns: string[]; rowCount: number; sha: string }> {
  const { sha } = await uploadFileInChunks(file, fileName)
  const res = await apiRequest<{ columns: string[]; rowCount: number }>(
    `${PROJ}/preview-columns`,
    { method: 'POST', body: JSON.stringify({ sha, fileName, parseOptions }) },
  )
  return { ...res, sha }
}

// The raw file bytes live in the content-addressed blob store, referenced by
// sha — they must never travel inside the project's JSON metadata.

/** Whether this project carries a new file to attach server-side: either fresh
 * bytes to upload, or a blob already uploaded during preview (server-mode
 * Parquet), referenced by preUploadedSha. */
function hasRawBuffer(project: Partial<MappingProject>): boolean {
  const fsd = project.fileSourceData
  return !!fsd?.rawFileBuffer?.byteLength || !!fsd?.preUploadedSha
}

/** Project metadata with the raw bytes and the client-only preUploadedSha
 * removed (rows stays empty — legacy only). */
function stripBuffer<T extends Partial<MappingProject>>(project: T): T {
  const fsd = project.fileSourceData
  if (!fsd) return project
  return {
    ...project,
    fileSourceData: { ...fsd, rawFileBuffer: undefined, preUploadedSha: undefined, rows: [] },
  }
}

/** Attach a file to the project server-side. If the blob was already uploaded
 * during preview (preUploadedSha), reuse it; otherwise upload the bytes now.
 * The original filename is kept so the server picks the right reader
 * (CSV/Parquet/Excel) from the extension — no format conversion. The project
 * must already exist (raw-file 404s otherwise). */
async function uploadRawFile(projectId: string, project: Partial<MappingProject>): Promise<void> {
  const fsd = project.fileSourceData
  if (!fsd) return
  const fileName = fsd.fileName || 'source.csv'
  let sha = fsd.preUploadedSha
  if (!sha) {
    const buffer = fsd.rawFileBuffer
    if (!buffer || buffer.byteLength === 0) return
    const blob = new Blob([buffer as unknown as BlobPart], { type: 'application/octet-stream' })
    ;({ sha } = await uploadFileInChunks(blob, fileName))
  }
  await apiRequest(`${PROJ}/${projectId}/raw-file`, {
    method: 'POST',
    body: JSON.stringify({ sha, fileName }),
  })
}

/** After upload, ask the server for the exact source row count (via the shared
 * source_concepts view) and persist it into fileSourceData.totalRowCount, so the
 * project stats show the real size instead of 0 (the preview no longer counts
 * client-side). Best-effort: a failure here (e.g. Excel extension missing on an
 * offline server) must not fail the whole save. */
async function patchServerRowCount(
  projectId: string,
  fsd: MappingProject['fileSourceData'] | undefined,
): Promise<void> {
  if (!fsd) return
  try {
    const rows = await queryFileSourceOnServer(
      projectId,
      'SELECT COUNT(*) AS n FROM source_concepts',
    )
    const raw = rows[0]?.n
    const total = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(total)) return
    const nextFsd = { ...fsd, rawFileBuffer: undefined, rows: [], totalRowCount: total }
    await apiRequest(`${PROJ}/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fileSourceData: nextFsd }),
    })
  } catch {
    /* leave totalRowCount as-is */
  }
}

export const apiMappingProjectStorage: MappingProjectStorage = {
  // The CSV bytes never come down in server mode — the source is queried
  // server-side (POST /mapping-projects/{id}/query). Responses carry metadata
  // only; the browser holds no rawFileBuffer.
  getAll: () => apiRequest<MappingProject[]>(PROJ),

  getByWorkspace: (workspaceId) =>
    apiRequest<MappingProject[]>(`${PROJ}?workspaceId=${encodeURIComponent(workspaceId)}`),

  getById: async (id) => {
    try {
      return await apiRequest<MappingProject>(`${PROJ}/${id}`)
    } catch {
      return undefined
    }
  },

  create: async (project) => {
    // Create the row first (metadata, no bytes), THEN upload the file — the
    // raw-file endpoint needs the project to exist.
    await apiRequest(PROJ, { method: 'POST', body: JSON.stringify(stripBuffer(project)) })
    if (hasRawBuffer(project)) {
      await uploadRawFile(project.id, project)
      await patchServerRowCount(project.id, project.fileSourceData)
    }
  },

  update: async (id, changes) => {
    await apiRequest(`${PROJ}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(stripBuffer(changes)),
    })
    if (hasRawBuffer(changes)) {
      await uploadRawFile(id, changes)
      await patchServerRowCount(id, changes.fileSourceData)
    }
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
    })
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
