import { apiRequest } from '@/lib/api-client'

/** Server file-browser (project Folders settings). Server mode only — these hit
 * the backend's real filesystem, gated on project-settings:write. */

export interface FsEntry {
  name: string
  path: string
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

export interface FsValidation {
  ok: boolean
  path?: string
  reason?: 'empty' | 'outside_roots' | 'not_found' | 'not_a_dir' | 'not_writable'
}

export interface FsCopyResult {
  copied: number
  skipped: number
  overwritten: number
}

export type FsConflictStrategy = 'ignore' | 'overwrite' | 'keep_both'

export interface FsResolvedDirs {
  ide: string
  scripts: string
  datasets: string
}

export function fsResolvedDirs(projectUid: string): Promise<FsResolvedDirs> {
  return apiRequest<FsResolvedDirs>(`/projects/${encodeURIComponent(projectUid)}/fs/resolved`)
}

export function fsListDir(projectUid: string, path: string): Promise<FsListing> {
  const q = new URLSearchParams({ path }).toString()
  return apiRequest<FsListing>(`/projects/${encodeURIComponent(projectUid)}/fs/list-dir?${q}`)
}

export function fsValidateDir(projectUid: string, path: string): Promise<FsValidation> {
  return apiRequest<FsValidation>(`/projects/${encodeURIComponent(projectUid)}/fs/validate`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export function fsRebindCopy(
  projectUid: string,
  src: string,
  dst: string,
  onConflict: FsConflictStrategy,
): Promise<FsCopyResult> {
  return apiRequest<FsCopyResult>(`/projects/${encodeURIComponent(projectUid)}/fs/rebind-copy`, {
    method: 'POST',
    body: JSON.stringify({ src, dst, on_conflict: onConflict }),
  })
}
