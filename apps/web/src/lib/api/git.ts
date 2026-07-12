/**
 * Server-mode git versioning API (push-only) + server-side clone for import.
 *
 * The backend versions the entity's *export tree*, so every sync call uploads the
 * export ZIP the frontend already knows how to build (buildProjectZip /
 * buildWorkspaceZip). The backend unpacks it, then diffs / commits / pushes.
 */
import { apiFetch, apiRequest } from '@/lib/api-client'
import type { FileChangeType } from '@/types'

export type GitScope = 'projects' | 'workspaces'

export interface GitFileChange {
  path: string
  changeType: FileChangeType | 'renamed'
}

export interface GitStatus {
  linked: boolean
  branch: string
  files: GitFileChange[]
  modified: number
  added: number
  deleted: number
}

export interface GitDiff {
  path: string
  changeType: FileChangeType | 'renamed'
  oldContent: string
  newContent: string
  tooLarge: boolean
  binary: boolean
}

export interface GitBranches {
  branches: string[]
  current: string | null
}

export interface GitCommitResult {
  committed: boolean
  pushed: boolean
  nothingToCommit: boolean
  commit?: { oid: string; message: string }
}

function base(scope: GitScope, id: string): string {
  return `/git/${scope}/${encodeURIComponent(id)}`
}

/** POST a multipart form (ZIP + fields) through apiFetch, parsing the JSON result. */
async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await apiFetch(`/api/v1${path}`, { method: 'POST', body: form })
  if (!res.ok) throw new Error((await res.text()) || `Git request failed (${res.status})`)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

function zipForm(zip: Blob, extra: Record<string, string> = {}): FormData {
  const form = new FormData()
  form.append('file', zip, 'export.zip')
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return form
}

export async function gitStatus(scope: GitScope, id: string, zip: Blob, branch?: string): Promise<GitStatus> {
  return postForm<GitStatus>(`${base(scope, id)}/status`, zipForm(zip, branch ? { branch } : {}))
}

export async function gitDiff(scope: GitScope, id: string, zip: Blob, path: string, branch?: string): Promise<GitDiff> {
  return postForm<GitDiff>(`${base(scope, id)}/diff`, zipForm(zip, { path, ...(branch ? { branch } : {}) }))
}

export async function gitCommitPush(
  scope: GitScope,
  id: string,
  zip: Blob,
  message: string,
  branch?: string,
  paths?: string[],
): Promise<GitCommitResult> {
  const form = zipForm(zip, { message, ...(branch ? { branch } : {}) })
  // Omitting `paths` entirely means "commit everything"; a subset stages only those.
  if (paths) for (const p of paths) form.append('paths', p)
  return postForm<GitCommitResult>(`${base(scope, id)}/commit-push`, form)
}

export async function gitBranches(scope: GitScope, id: string): Promise<GitBranches> {
  return apiRequest<GitBranches>(`${base(scope, id)}/branches`)
}

export interface GitVerifyResult {
  ok: boolean
  branches: string[]
  default: string | null
}

/**
 * Check a remote is reachable with the given credentials before linking.
 * Throws (with the git error message) if the URL is wrong or auth fails, so the
 * caller can refuse to save a link that doesn't actually work.
 */
export async function gitVerifyRemote(url: string, token?: string): Promise<GitVerifyResult> {
  const res = await apiFetch('/api/v1/git/verify-remote', {
    method: 'POST',
    body: JSON.stringify({ url, token: token || undefined }),
  })
  if (!res.ok) throw new Error((await res.text()) || `Remote not reachable (${res.status})`)
  return res.json()
}

/** Clone a remote server-side, returning its content as a ZIP Blob for import. */
export async function gitCloneToZip(url: string, branch: string, token?: string): Promise<Blob> {
  const res = await apiFetch('/api/v1/git/clone', {
    method: 'POST',
    body: JSON.stringify({ url, branch, token: token || undefined }),
  })
  if (!res.ok) throw new Error((await res.text()) || `Clone failed (${res.status})`)
  return res.blob()
}
