/**
 * Server-mode git versioning API (push-only) + server-side clone for import.
 *
 * The backend versions the entity's *export tree*, so every sync call uploads the
 * export ZIP the frontend already knows how to build (buildProjectZip /
 * buildWorkspaceZip). The backend unpacks it, then diffs / commits / pushes.
 */
import { apiFetch, apiRequest } from '@/lib/api-client'
import type { FileChangeType } from '@/types'

export type GitScope = 'projects' | 'workspaces' | 'mapping-projects'

export interface GitFileChange {
  path: string
  changeType: FileChangeType | 'renamed'
  /** Working-tree byte size (0 for deletions); drives default LFS tracking. */
  size: number
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
  /** Content is a preview capped to the first lines/bytes of a large file. */
  truncated: boolean
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

/** POST a multipart form (ZIP + fields) through apiFetch, parsing the JSON result.
 *  On failure throws a GitRemoteError (code + raw), so callers show a friendly
 *  message instead of the raw {detail:{…}} JSON. */
async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await apiFetch(`/api/v1${path}`, { method: 'POST', body: form })
  if (!res.ok) throw await gitError(res)
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

/** Git error codes the backend classifies; the UI maps these to friendly text. */
export type GitErrorCode = 'auth_required' | 'auth_failed' | 'not_found' | 'network' | 'unknown'

/** A git operation failed: `code` drives the friendly message, `rawMessage` is
 *  the underlying git output shown on demand. */
export class GitRemoteError extends Error {
  code: GitErrorCode
  rawMessage: string
  constructor(code: GitErrorCode, rawMessage: string) {
    super(rawMessage)
    this.name = 'GitRemoteError'
    this.code = code
    this.rawMessage = rawMessage
  }
}

/** Turn a non-OK git response into a GitRemoteError, parsing the {code,message}
 *  detail when present (falls back to raw text / plain error). */
async function gitError(res: Response): Promise<GitRemoteError> {
  const text = await res.text()
  try {
    const body = JSON.parse(text)
    const detail = body?.detail
    if (detail && typeof detail === 'object' && 'code' in detail) {
      return new GitRemoteError(detail.code as GitErrorCode, detail.message ?? text)
    }
    return new GitRemoteError('unknown', typeof detail === 'string' ? detail : text)
  } catch {
    return new GitRemoteError('unknown', text || `Request failed (${res.status})`)
  }
}

/**
 * Check a remote is reachable with the given credentials before linking.
 * Throws GitRemoteError (with a code) if the URL is wrong or auth fails, so the
 * caller can refuse to save a link that doesn't actually work.
 */
export async function gitVerifyRemote(url: string, token?: string): Promise<GitVerifyResult> {
  const res = await apiFetch('/api/v1/git/verify-remote', {
    method: 'POST',
    body: JSON.stringify({ url, token: token || undefined }),
  })
  if (!res.ok) throw await gitError(res)
  return res.json()
}

/** Clone a remote server-side, returning its content as a ZIP Blob for import. */
export async function gitCloneToZip(url: string, branch: string, token?: string): Promise<Blob> {
  const res = await apiFetch('/api/v1/git/clone', {
    method: 'POST',
    body: JSON.stringify({ url, branch, token: token || undefined }),
  })
  if (!res.ok) throw await gitError(res)
  return res.blob()
}
