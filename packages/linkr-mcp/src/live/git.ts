/** Pure helpers for the read-only git tools: routes per entity kind, and readable reports. */
import type { GitBranches, GitDiff, GitStatus, GitSyncState } from '@/lib/api/git'

export type GitEntity =
  | 'project' | 'workspace' | 'mapping_project' | 'sql_collection' | 'etl_pipeline' | 'data_catalog'
  | 'dq_rule_set' | 'schema_preset' | 'database' | 'plugin'

/** The server's route prefix per entity kind, and whether it reports the remote sync state. */
export const GIT_ENTITIES: Record<GitEntity, { prefix: string; syncState: boolean }> = {
  project: { prefix: 'projects', syncState: true },
  workspace: { prefix: 'workspaces', syncState: false },
  mapping_project: { prefix: 'mapping-projects', syncState: true },
  sql_collection: { prefix: 'sql-script-collections', syncState: false },
  etl_pipeline: { prefix: 'etl-pipelines', syncState: true },
  data_catalog: { prefix: 'data-catalogs', syncState: true },
  dq_rule_set: { prefix: 'dq-rule-sets', syncState: true },
  schema_preset: { prefix: 'schema-presets', syncState: true },
  database: { prefix: 'databases', syncState: true },
  plugin: { prefix: 'user-plugins', syncState: true },
}

export const GIT_ENTITY_KINDS = Object.keys(GIT_ENTITIES) as GitEntity[]

export function gitPath(kind: GitEntity, id: string, op: 'status' | 'diff' | 'branches' | 'sync-state', branch?: string): string {
  const entity = GIT_ENTITIES[kind]
  if (!entity) throw new Error(`Unknown entity kind "${kind}"; one of ${GIT_ENTITY_KINDS.join(', ')}.`)
  const qs = op === 'sync-state' && branch ? `?branch=${encodeURIComponent(branch)}` : ''
  return `/git/${entity.prefix}/${encodeURIComponent(id)}/${op}${qs}`
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`

/** What a commit would change, by file, cut at `maxFiles`. */
export function formatStatus(s: GitStatus, maxFiles = 80): string {
  if (!s.linked) {
    return 'Not linked to a git repository: the user links it in Linkr (Versioning → Git repository). '
      + `Against an empty history the export would add ${s.files.length} file(s).`
  }
  if (s.files.length === 0) return `Branch ${s.branch}: up to date — the Linkr content matches the remote branch, nothing to commit.`
  const lines = [`Branch ${s.branch}: ${s.files.length} file(s) differ from the remote branch — `
    + `${s.modified} modified, ${s.added} added, ${s.deleted} deleted (local changes not pushed yet).`]
  const sorted = [...s.files].sort((a, b) => a.path.localeCompare(b.path))
  for (const f of sorted.slice(0, maxFiles)) {
    const from = f.changeType === 'renamed' && f.oldPath ? ` (from ${f.oldPath})` : ''
    lines.push(`- ${f.changeType} ${f.path}${from}${f.changeType !== 'deleted' && f.size ? ` · ${size(f.size)}` : ''}`)
  }
  if (sorted.length > maxFiles) lines.push(`… ${sorted.length - maxFiles} more file(s)`)
  return lines.join('\n')
}

export function formatSyncState(s: GitSyncState): string {
  if (!s.linked) return 'Not linked to a git repository.'
  if (!s.remoteHead) return `Branch ${s.branch} does not exist on the remote yet (nothing pushed).`
  const anchor = s.reviewedOid ?? s.syncedOid
  if (!anchor) {
    return `Remote branch ${s.branch} is at ${s.remoteHead.slice(0, 10)}, but this Linkr copy was never anchored to a commit `
      + '(not imported from git, never pushed): whether it is behind cannot be told.'
  }
  if (s.diverged) {
    return `Diverged: remote branch ${s.branch} (${s.remoteHead.slice(0, 10)}) no longer contains the last synced commit `
      + `${anchor.slice(0, 10)} (history rewritten). The user resolves it in Linkr (Versioning → pull).`
  }
  if (s.behind) {
    return `Behind: remote branch ${s.branch} moved to ${s.remoteHead.slice(0, 10)} since the last sync (${anchor.slice(0, 10)}). `
      + 'Someone pushed; the user pulls in Linkr before pushing.'
  }
  return `In sync with remote branch ${s.branch} at ${s.remoteHead.slice(0, 10)}.`
}

export function formatBranches(b: GitBranches): string {
  if (b.branches.length === 0) return 'No branch (no remote, or an empty repository).'
  return b.branches.map((name) => `- ${name}${name === b.current ? ' (current)' : ''}`).join('\n')
}

const GIT_ERRORS: Record<string, string> = {
  auth_required: 'The remote needs credentials and the user has no access token for this host. They add one in Linkr '
    + '(Versioning → Git repository); never ask for it in this conversation.',
  auth_failed: 'The remote refused the user\'s access token (expired or lacking rights). They update it in Linkr; never ask for it here.',
  not_found: 'The remote repository or branch was not found.',
  network: 'The git host could not be reached.',
  pull_required: 'The remote has commits this Linkr copy has not pulled.',
  export_failed: 'Linkr could not build the entity\'s export tree.',
}

/** A git route's structured 400 (`{"code","message"}`), made readable; null when it is not one. */
export function explainGitError(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { code?: string; message?: string }
    if (!parsed || typeof parsed.code !== 'string') return null
    const known = GIT_ERRORS[parsed.code]
    return `${known ?? `Git error (${parsed.code}).`}${parsed.message ? ` Details: ${parsed.message.slice(0, 500)}` : ''}`
  } catch {
    return null
  }
}

/** Line diff of two texts in unified form (3 lines of context), cut at `maxLines`.
 *  An LCS table; past `maxCells` it is too costly and the two sides are shown instead. */
export function unifiedDiff(oldText: string, newText: string, maxLines = 400, maxCells = 4_000_000): string {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const clipLines = (lines: string[]) => lines.length > maxLines
    ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more line(s)`]
    : lines
  if (a.length * b.length > maxCells) {
    const half = Math.floor(maxLines / 2)
    return ['(too large for a line diff: both sides, cut)', '--- before', ...clipLines(a).slice(0, half),
      '+++ after', ...clipLines(b).slice(0, half)].join('\n')
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: { tag: ' ' | '-' | '+'; line: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ tag: ' ', line: a[i] }); i++; j++ }
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ tag: '-', line: a[i] }); i++ }
    else { ops.push({ tag: '+', line: b[j] }); j++ }
  }
  const keep = ops.map((op, k) => op.tag !== ' '
    || ops.slice(Math.max(0, k - 3), k + 4).some((o) => o.tag !== ' '))
  const out: string[] = []
  ops.forEach((op, k) => {
    if (keep[k]) out.push(`${op.tag}${op.line}`)
    else if (k === 0 || keep[k - 1]) out.push('…')
  })
  return out.length ? clipLines(out).join('\n') : '(no line changed)'
}

/** One file's diff against the remote branch, for the model. */
export function formatDiff(d: GitDiff, maxLines = 400): string {
  const from = d.oldPath && d.oldPath !== d.path ? ` (from ${d.oldPath})` : ''
  const head = `${d.changeType} ${d.path}${from}`
  if (d.binary) return `${head}\n(binary file: no text diff)`
  if (d.truncationMode === 'eol_only') return `${head}\nOnly the line endings differ (CRLF ↔ LF).`
  if (d.truncationMode === 'no_content_change') return `${head}\nSame bytes: git flags it modified for another reason (storage mode, stale index).`
  if (d.truncationMode === 'too_large') return `${head}\n(too large to diff)`
  const note = d.truncated ? `\n(the server cut the content: ${d.truncationMode})` : ''
  return `${head}${note}\n${unifiedDiff(d.oldContent, d.newContent, maxLines)}`
}
