import { apiRequest } from '@/lib/api-client'

/** Server file-browser (project Folders settings). Server mode only — these hit
 * the backend's real filesystem, gated on project-settings:write. */

export interface FsEntry {
  name: string
  path: string
  /** Absent on folder-only listings, where every entry is a directory. */
  isDir?: boolean
  size?: number | null
  readable?: boolean
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

export type FsValidationReason =
  | 'empty'
  | 'outside_roots'
  | 'not_found'
  | 'not_a_dir'
  | 'not_a_file'
  | 'not_writable'
  | 'not_readable'
  | 'wrong_extension'

export interface FsValidation {
  ok: boolean
  path?: string
  reason?: FsValidationReason
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
  /** Default dirs regardless of the current binding (for a "reset to default" jump). */
  defaults: { ide: string; scripts: string; datasets: string }
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

/** Which authority a browse request answers to. A project binds its IDE folders
 *  (project-settings:write); a workspace points a database at server data
 *  (databases:write). The scope picks the route, and the route picks the gate. */
export type FsScope =
  | { kind: 'project'; projectUid: string }
  | { kind: 'workspace'; workspaceId: string }

function scopePrefix(scope: FsScope): string {
  return scope.kind === 'project'
    ? `/projects/${encodeURIComponent(scope.projectUid)}/fs`
    : `/workspaces/${encodeURIComponent(scope.workspaceId)}/fs`
}

export function fsBrowse(
  scope: FsScope,
  path: string,
  opts: { includeFiles?: boolean; extensions?: string[] } = {},
): Promise<FsListing> {
  const q = new URLSearchParams({ path })
  if (opts.includeFiles) q.set('includeFiles', 'true')
  if (opts.extensions?.length) q.set('extensions', opts.extensions.join(','))
  return apiRequest<FsListing>(`${scopePrefix(scope)}/list-dir?${q.toString()}`)
}

/** Validate a chosen path. Server mode re-checks this where it persists the
 *  value, so this is for feedback in the picker, not a security control. */
export function fsValidatePath(
  workspaceId: string,
  path: string,
  expect: 'file' | 'dir',
  extensions?: string[],
): Promise<FsValidation> {
  return apiRequest<FsValidation>(
    `/workspaces/${encodeURIComponent(workspaceId)}/fs/validate-path`,
    { method: 'POST', body: JSON.stringify({ path, expect, extensions }) },
  )
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
