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
  // Databases are not versionable (no git panel of their own), but they ARE
  // git-linkable as a workspace child, so their content can be missing after an
  // import — which is what the content-status rows record.
  | 'databases'
  | 'user-plugins'
  // Account-level settings (organizations + users + roles), id "account". The
  // server builds the export tree; the panel drives which files to push.
  | 'settings'

export interface GitFileChange {
  path: string
  changeType: FileChangeType | 'renamed'
  /** Working-tree byte size (0 for deletions); drives default LFS tracking. */
  size: number
  /** Pre-rename path, present only when changeType is 'renamed'. The diff call
   *  needs it: HEAD still knows the file under this name. */
  oldPath?: string | null
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
  truncationMode: 'none' | 'head' | 'hunks' | 'eol_only' | 'no_content_change' | 'too_large'
  binary: boolean
  /** Set when the old side was read from a pre-rename path, so the viewer can
   *  label the left pane with the name the file used to have. */
  oldPath?: string | null
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
  /** Content anchor: last commit whose content we hold (the 3-way merge base).
   *  Advances only on a COMPLETE pull — moving it on a partial one would bury
   *  the items the user declined. Null if never anchored. */
  syncedOid: string | null
  /** Decision cursor: last commit every incoming item of which got an explicit
   *  decision (taken, or deliberately declined). This is what gates the push, and
   *  what behind/diverged are measured against. Null if never reviewed. */
  reviewedOid: string | null
  /** The remote moved past our decision cursor (there are commits to pull). */
  behind: boolean
  /** The cursor isn't an ancestor of the remote head (history rewritten). */
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

export async function gitStatus(scope: GitScope, id: string, zip: Blob | null, branch?: string): Promise<GitStatus> {
  return postForm<GitStatus>(`${base(scope, id)}/status`, zipForm(zip, { ...(branch ? { branch } : {}) }))
}

/** `full` returns both sides verbatim, skipping every size guard — for callers
 *  that PARSE the content rather than render it (a truncated payload is not valid
 *  JSON). Supported by the mapping-project scope only.
 *
 *  `oldPath` is the pre-rename path from the status listing. Pass it for a
 *  `renamed` file: HEAD stores it under the old name, so without it the server
 *  finds nothing there and the left pane renders empty. The form field is
 *  snake_case because FastAPI `Form(...)` params are raw argument names — the
 *  camelCase alias applies to response bodies, not to form input. */
export async function gitDiff(scope: GitScope, id: string, zip: Blob | null, path: string, branch?: string, full?: boolean, oldPath?: string): Promise<GitDiff> {
  return postForm<GitDiff>(`${base(scope, id)}/diff`, zipForm(zip, {
    path,
    ...(branch ? { branch } : {}),
    ...(full ? { full: 'true' } : {}),
    ...(oldPath ? { old_path: oldPath } : {}),
  }))
}

export async function gitCommitPush(
  scope: GitScope,
  id: string,
  zip: Blob | null,
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

/** Row-level diff of the source concept list, keyed by (vocabulary_id, concept_code).
 *  Computed server-side (both sides are already on disk there — shipping two ~5 MB
 *  CSVs to the browser to count rows would cost more than the pull). */
/** One source concept the remote list would add, remove or change. */
export interface SourceConceptChange {
  key: string
  state: 'add' | 'delete' | 'modify'
  vocabulary: string
  code: string
  name: string
}

export interface SourceConceptsDiff {
  /** False when a side couldn't be parsed (unsmudged LFS pointer, missing identity
   *  column, absent file) — the counts are then meaningless and the UI must offer
   *  the file as a whole rather than show a bogus 0/0. */
  keyed: boolean
  added: number
  removed: number
  modified: number
  unchanged: number
  localTotal: number
  remoteTotal: number
  /** The rows that moved, for the review dialog. Capped server-side; the counts
   *  above stay exact, so a truncated listing never understates the change. */
  changes: SourceConceptChange[]
  changesTruncated: boolean
}

export interface GitPullPreview {
  branch: string
  remoteHead: string | null
  syncedOid: string | null
  base: GitPullSide
  remote: GitPullSide
  sourceConceptsDiff: SourceConceptsDiff
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
 *  import). Without this the entity has no base and "behind" can't be detected.
 *
 *  `reviewedOnly` records a *partial but fully deliberated* pull: the user decided
 *  on every incoming item and kept their own version of some, so the content
 *  anchor must NOT move (it would absorb what they declined) while the decision
 *  cursor does — clearing the banner and unblocking the push. */
export async function gitSetSyncState(
  scope: GitScope,
  id: string,
  branch: string,
  syncedOid: string,
  reviewedOnly = false,
): Promise<void> {
  const res = await apiFetch(`/api/v1${base(scope, id)}/set-sync-state`, {
    method: 'POST',
    body: JSON.stringify({ branch, syncedOid, reviewedOnly }),
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

/**
 * A linked type's scope for CONTENT-STATUS purposes only.
 *
 * Wider than `scopeForLinkedType`: a database is git-linkable inside a workspace
 * and so its content can be missing after an import, but it has no versioning
 * panel and no sync-state endpoint — anchoring one would POST to a route that
 * does not exist. The two questions ("can I version this?" and "did this
 * entity's content arrive?") have different answers, so they get different maps.
 *
 * Without the database entry `syncContentStatus` bailed on the unmapped type,
 * and a git-linked database was the one linked entity that never showed the
 * "content not imported" badge.
 */
export const contentScopeForLinkedType: Record<string, GitScope> = {
  ...scopeForLinkedType,
  'database': 'databases',
}

/** Inverse of contentScopeForLinkedType: GitScope → the singular GitLinkedEntity
 *  type. Built from the wider map so a `databases` scope resolves back — this is
 *  what the card badge uses to name the entity it offers to retry. */
export const linkedTypeForScope: Partial<Record<GitScope, string>> = Object.fromEntries(
  Object.entries(contentScopeForLinkedType).map(([type, scope]) => [scope, type]),
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
