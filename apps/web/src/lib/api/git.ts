/**
 * Server-mode git versioning API (push-only) + server-side clone for import.
 *
 * The backend versions the entity's *export tree*, so every sync call uploads the
 * export ZIP the frontend already knows how to build (buildProjectZip /
 * buildWorkspaceZip). The backend unpacks it, then diffs / commits / pushes.
 */
import { apiFetch, apiRequest } from '@/lib/api-client'
import type { FileChangeType } from '@/types'

export type GitScope =
  | 'projects'
  | 'workspaces'
  | 'mapping-projects'
  | 'sql-script-collections'
  | 'etl-pipelines'
  | 'data-catalogs'
  | 'dq-rule-sets'
  | 'schema-presets'
  | 'user-plugins'
  // Account-level settings (organizations + users + roles), id "account". The
  // server builds the export tree; the panel drives which files to push.
  | 'settings'

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
  /** Some content was dropped; truncationMode says how it was rendered. */
  truncated: boolean
  /**
   * 'none'              — full content
   * 'head'              — oversized file: first lines/bytes only
   * 'hunks'             — oversized modified file condensed to its changed blocks + context
   * 'eol_only'          — flagged modified but only the line-ending style differs (CRLF↔LF)
   * 'no_content_change' — identical bytes; flagged modified by a storage-mode switch (e.g. text→LFS)
   */
  truncationMode: 'none' | 'head' | 'hunks' | 'eol_only' | 'no_content_change'
  binary: boolean
}

export interface GitBranches {
  branches: string[]
  current: string | null
}

export interface GitSyncState {
  linked: boolean
  branch: string
  /** oid of origin/<branch>, or null when the remote/branch doesn't exist yet. */
  remoteHead: string | null
  /** Last commit we know we were in sync with, or null if never anchored. */
  syncedOid: string | null
  /** The remote moved past our anchor (there are commits to pull). */
  behind: boolean
  /** The anchor isn't an ancestor of the remote head (history rewritten). */
  diverged: boolean
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

// `zip` is null when the server builds the export itself (mapping projects in
// server mode): omit the file part so the backend assembles the ZIP.
function zipForm(zip: Blob | null, extra: Record<string, string> = {}): FormData {
  const form = new FormData()
  if (zip) form.append('file', zip, 'export.zip')
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return form
}

// When the server builds the ZIP (zip === null), the include-data toggle is baked
// into the client build for other scopes but must be sent explicitly for projects,
// whose server builder honors it (raw dataset files gitignored unless included).
function includeDataField(zip: Blob | null, includeData?: boolean): Record<string, string> {
  return zip === null && includeData !== undefined ? { include_data: String(includeData) } : {}
}

export async function gitStatus(scope: GitScope, id: string, zip: Blob | null, branch?: string, includeData?: boolean): Promise<GitStatus> {
  return postForm<GitStatus>(`${base(scope, id)}/status`, zipForm(zip, { ...(branch ? { branch } : {}), ...includeDataField(zip, includeData) }))
}

export async function gitDiff(scope: GitScope, id: string, zip: Blob | null, path: string, branch?: string, includeData?: boolean): Promise<GitDiff> {
  return postForm<GitDiff>(`${base(scope, id)}/diff`, zipForm(zip, { path, ...(branch ? { branch } : {}), ...includeDataField(zip, includeData) }))
}

export async function gitCommitPush(
  scope: GitScope,
  id: string,
  zip: Blob | null,
  message: string,
  branch?: string,
  paths?: string[],
  includeData?: boolean,
): Promise<GitCommitResult> {
  const form = zipForm(zip, { message, ...(branch ? { branch } : {}), ...includeDataField(zip, includeData) })
  // Omitting `paths` entirely means "commit everything"; a subset stages only those.
  if (paths) for (const p of paths) form.append('paths', p)
  return postForm<GitCommitResult>(`${base(scope, id)}/commit-push`, form)
}

export async function gitBranches(scope: GitScope, id: string): Promise<GitBranches> {
  return apiRequest<GitBranches>(`${base(scope, id)}/branches`)
}

/** Where the entity stands vs the remote branch (behind / diverged). Cheap: a GET
 *  that only compares oids on the remote — no export ZIP, so the client needn't
 *  rebuild the (possibly heavy) export just to learn it's out of date. The anchor
 *  is set at import and moved on push. v1: mapping-projects. */
export async function gitSyncState(scope: GitScope, id: string, branch?: string): Promise<GitSyncState> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : ''
  return apiRequest<GitSyncState>(`${base(scope, id)}/sync-state${qs}`)
}

export interface GitVerifyResult {
  ok: boolean
  branches: string[]
  default: string | null
}

/** Git error codes the backend classifies; the UI maps these to friendly text. */
export type GitErrorCode = 'auth_required' | 'auth_failed' | 'not_found' | 'network' | 'pull_required' | 'unknown'

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
export async function gitError(res: Response): Promise<GitRemoteError> {
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

export interface GitHostTokenStatus {
  host: string | null
  hasToken: boolean
}

/** Store (or clear, with an empty token) the CURRENT USER's git access token for
 *  the host of `url`. Tokens are per (user, host): the same token is reused for
 *  every repo on that host, and one user never pushes with another's token. The
 *  token is never returned by the API. */
export async function gitSetHostToken(url: string, token: string | null): Promise<GitHostTokenStatus> {
  const res = await apiFetch('/api/v1/git/host-token', {
    method: 'PUT',
    body: JSON.stringify({ url, token: token || undefined }),
  })
  if (!res.ok) throw await gitError(res)
  return res.json()
}

/** Whether the current user has a token stored for the host of `url` (presence
 *  only — the token itself is never returned). */
export async function gitHostTokenStatus(url: string): Promise<GitHostTokenStatus> {
  return apiRequest<GitHostTokenStatus>(`/git/host-token?url=${encodeURIComponent(url)}`)
}

/** Clone a remote server-side, returning its content as a ZIP Blob for import,
 *  plus the cloned HEAD oid (so the import can anchor the new entity's sync
 *  state to it — see gitSetSyncState). */
export async function gitCloneToZip(
  url: string,
  branch: string,
  token?: string,
): Promise<{ blob: Blob; oid: string | null }> {
  const res = await apiFetch('/api/v1/git/clone', {
    method: 'POST',
    body: JSON.stringify({ url, branch, token: token || undefined }),
  })
  if (!res.ok) throw await gitError(res)
  const oid = res.headers.get('X-Git-Cloned-Oid')
  return { blob: await res.blob(), oid }
}

export interface GitPullSide {
  /** Managed JSON files → full text (null if absent at that commit). */
  files: Record<string, string | null>
  /** Heavy whole-list families → stats only. `oid` fingerprints the content at
   *  this commit (for LFS, the pointer's oid), so base↔remote oid tells "changed"
   *  without smudging. rowCount is present only for non-LFS CSVs. */
  stats: Record<string, { present: boolean; oid?: string; rowCount?: number; byteSize?: number; lfs?: boolean }>
}

export interface GitPullPreview {
  branch: string
  remoteHead: string | null
  syncedOid: string | null
  base: GitPullSide
  remote: GitPullSide
}

/** Fetch BASE + REMOTE managed-file content for a 3-way merge against the local DB.
 *  Cheap: JSON families come as text, heavy families as stats. v1: mapping-projects. */
export async function gitPullPreview(scope: GitScope, id: string, branch?: string): Promise<GitPullPreview> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : ''
  return apiRequest<GitPullPreview>(`${base(scope, id)}/pull-preview${qs}`)
}

/** Fetch the raw bytes of a heavy managed file (source CSV / scores parquet) at the
 *  remote head — used when the pull takes the remote version of a whole-list family. */
export async function gitPullFile(scope: GitScope, id: string, path: string, branch?: string): Promise<Uint8Array> {
  const qs = `?path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`
  const res = await apiFetch(`/api/v1${base(scope, id)}/pull-file${qs}`)
  if (!res.ok) throw await gitError(res)
  return new Uint8Array(await res.arrayBuffer())
}

/** Anchor an entity's sync state to a known remote commit (used right after a git
 *  import). Without this the entity has no base and "behind" can't be detected. */
export async function gitSetSyncState(scope: GitScope, id: string, branch: string, syncedOid: string): Promise<void> {
  const res = await apiFetch(`/api/v1${base(scope, id)}/set-sync-state`, {
    method: 'POST',
    body: JSON.stringify({ branch, syncedOid }),
  })
  if (!res.ok) throw await gitError(res)
}

/** A git-linked entity whose content isn't reconstituted yet (pointer imported,
 *  clone pending or failed). Drives the "content not imported" card badge. */
export interface GitContentStatus {
  scope: GitScope
  entityId: string
  status: 'pending' | 'failed'
}

/** Map a GitLinkedEntity.type (singular) to its GitScope (the API path segment). */
export const scopeForLinkedType: Record<string, GitScope> = {
  'project': 'projects',
  'mapping-project': 'mapping-projects',
  'sql-collection': 'sql-script-collections',
  'etl-pipeline': 'etl-pipelines',
  'data-catalog': 'data-catalogs',
  'dq-rule-set': 'dq-rule-sets',
  'schema-preset': 'schema-presets',
}

/** Inverse of scopeForLinkedType: GitScope → the singular GitLinkedEntity type. */
export const linkedTypeForScope: Partial<Record<GitScope, string>> = Object.fromEntries(
  Object.entries(scopeForLinkedType).map(([type, scope]) => [scope, type]),
)

export async function gitContentStatusList(workspaceId: string): Promise<GitContentStatus[]> {
  const res = await apiFetch(`/api/v1/git/workspaces/${workspaceId}/content-status`)
  if (!res.ok) throw await gitError(res)
  return res.json()
}

export async function gitSetContentStatus(workspaceId: string, scope: GitScope, entityId: string, status: 'pending' | 'failed'): Promise<void> {
  const res = await apiFetch(`/api/v1/git/workspaces/${workspaceId}/content-status`, {
    method: 'PUT',
    body: JSON.stringify({ scope, entityId, status }),
  })
  if (!res.ok) throw await gitError(res)
}

export async function gitClearContentStatus(workspaceId: string, scope: GitScope, entityId: string): Promise<void> {
  const res = await apiFetch(`/api/v1/git/workspaces/${workspaceId}/content-status/${scope}/${entityId}`, { method: 'DELETE' })
  if (!res.ok) throw await gitError(res)
}
