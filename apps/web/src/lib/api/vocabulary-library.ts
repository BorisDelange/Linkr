import { apiRequest } from '@/lib/api-client'
import { uploadFileInChunks } from '@/lib/api/upload'
import type { InspectedExport, LibraryVocabulary } from '@/lib/vocabulary-library/types'

/** Where an ATHENA export is, server-side. */
export type ServerExportSource =
  | { files: { fileName: string; sha: string }[] }
  | { serverPath: string }
  | { dataSourceId: string }

export interface ServerImportState {
  id: string
  status: 'running' | 'done' | 'error'
  step: string
  done: number
  total: number
  error: string | null
}

const base = (workspaceId: string) => `/workspaces/${workspaceId}/vocabulary-library`

export function fetchLibraryFromServer(workspaceId: string): Promise<{ dataSourceId: string | null; vocabularies: LibraryVocabulary[] }> {
  return apiRequest(base(workspaceId))
}

/** Upload the files of a picked ATHENA folder; the names keep their relative
 *  path, which is how the server tells the tables apart. */
export async function uploadExportFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<ServerExportSource> {
  const out: { fileName: string; sha: string }[] = []
  for (const [i, file] of files.entries()) {
    const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const { sha } = await uploadFileInChunks(file, name)
    out.push({ fileName: name, sha })
    onProgress?.(i + 1, files.length)
  }
  return { files: out }
}

export function inspectExportOnServer(workspaceId: string, source: ServerExportSource): Promise<InspectedExport> {
  return apiRequest(`${base(workspaceId)}/inspect`, { method: 'POST', body: JSON.stringify(source) })
}

export function startImportOnServer(workspaceId: string, source: ServerExportSource, vocabularies: string[]): Promise<ServerImportState> {
  return apiRequest(`${base(workspaceId)}/import`, { method: 'POST', body: JSON.stringify({ source, vocabularies }) })
}

export function fetchImportState(workspaceId: string, importId: string): Promise<ServerImportState> {
  return apiRequest(`${base(workspaceId)}/imports/${importId}`)
}

export async function removeVocabularyOnServer(workspaceId: string, vocabularyId: string): Promise<void> {
  await apiRequest(`${base(workspaceId)}/vocabularies/${encodeURIComponent(vocabularyId)}`, { method: 'DELETE' })
}
