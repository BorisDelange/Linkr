/**
 * Git versioning, read-only: what a Linkr entity would commit, whether its
 * remote moved, its branches. Committing, pushing and pulling stay in the app.
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { GitBranches, GitDiff, GitStatus, GitSyncState } from '@/lib/api/git'
import { ApiError } from './api.js'
import {
  GIT_ENTITIES, GIT_ENTITY_KINDS, explainGitError, formatBranches, formatDiff, formatStatus, formatSyncState, gitPath,
  type GitEntity,
} from './git.js'
import { READ, api, failure, guard, text, type Server, type ToolResult } from './shared.js'

// Reads, but they fetch from the git host.
const REMOTE_READ = { ...READ, openWorldHint: true } as const

const entitySchema = {
  entity: {
    type: 'string', enum: GIT_ENTITY_KINDS,
    description: 'What is versioned: a project (project_uid), a workspace, a mapping project, or a workspace entity '
      + '(SQL collection, ETL pipeline, data catalog, DQ rule set, schema preset, database, plugin).',
  },
  id: { type: 'string', description: 'Its id (a project\'s project_uid).' },
}

/** The git routes read `Form(...)` fields; with no `file` part the server builds the export itself. */
function gitForm(fields: Record<string, string | undefined>): FormData {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v)
  return form
}

async function gitCall(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiError) {
      const explained = explainGitError(e.message)
      if (explained) return failure(explained)
    }
    throw e
  }
}

export function registerGitTools(server: Server): void {
  server.registerTool('get_git_status', {
    description: 'Git versioning of a Linkr entity (Versioning → Git repository in the app): the files its current '
      + 'content would change in the linked remote branch — the local work not pushed yet — and, where Linkr tracks it, '
      + 'whether the remote moved since the last sync. Builds the entity\'s export on the server, which can take a while '
      + 'for a large mapping project or workspace. Read-only: committing and pushing are done by the user in Linkr.',
    annotations: REMOTE_READ,
    inputSchema: fromJsonSchema<{ entity: GitEntity; id: string; branch?: string; max_files?: number }>({
      type: 'object',
      properties: {
        ...entitySchema,
        branch: { type: 'string', description: 'Compare with this branch. Default: the linked branch.' },
        max_files: { type: 'number', description: 'Files listed, default 80, max 300.' },
      },
      required: ['entity', 'id'],
    }),
  }, guard(async ({ entity, id, branch, max_files }) => gitCall(async () => {
    if (!GIT_ENTITIES[entity]) return failure(`entity must be one of ${GIT_ENTITY_KINDS.join(', ')}.`)
    const status = await api.request<GitStatus>('POST', gitPath(entity, id, 'status'), gitForm({ branch }))
    const lines = [formatStatus(status, Math.min(Math.max(1, Math.floor(max_files ?? 80)), 300))]
    if (status.linked && GIT_ENTITIES[entity].syncState) {
      const sync = await api.request<GitSyncState>('GET', gitPath(entity, id, 'sync-state', status.branch)).catch(() => null)
      if (sync) lines.push('', `Remote: ${formatSyncState(sync)}`)
    }
    return text(lines.join('\n'))
  })))

  server.registerTool('get_git_diff', {
    description: 'The change of one file of a git-linked Linkr entity against its remote branch, as a unified line '
      + 'diff: what a commit would change in it. Take the path (and, for a renamed file, its old path) from '
      + 'get_git_status. Read-only.',
    annotations: REMOTE_READ,
    inputSchema: fromJsonSchema<{
      entity: GitEntity; id: string; path: string; old_path?: string; branch?: string; max_lines?: number
    }>({
      type: 'object',
      properties: {
        ...entitySchema,
        path: { type: 'string', description: 'A file path as get_git_status lists it.' },
        old_path: { type: 'string', description: 'For a renamed file: its path before the rename.' },
        branch: { type: 'string', description: 'Default: the linked branch.' },
        max_lines: { type: 'number', description: 'Diff lines shown, default 400, max 2000.' },
      },
      required: ['entity', 'id', 'path'],
    }),
  }, guard(async ({ entity, id, path, old_path, branch, max_lines }) => gitCall(async () => {
    if (!GIT_ENTITIES[entity]) return failure(`entity must be one of ${GIT_ENTITY_KINDS.join(', ')}.`)
    const diff = await api.request<GitDiff>('POST', gitPath(entity, id, 'diff'), gitForm({ path, branch, old_path }))
    return text(formatDiff(diff, Math.min(Math.max(1, Math.floor(max_lines ?? 400)), 2000)))
  })))

  server.registerTool('get_git_sync_state', {
    description: 'Cheap check of whether a git-linked Linkr entity is behind its remote branch (someone pushed since the '
      + 'last pull / push) or diverged from it. Does not look at local changes (get_git_status does). Not available for '
      + 'workspaces and SQL collections.',
    annotations: REMOTE_READ,
    inputSchema: fromJsonSchema<{ entity: GitEntity; id: string; branch?: string }>({
      type: 'object',
      properties: { ...entitySchema, branch: { type: 'string', description: 'Default: the linked branch.' } },
      required: ['entity', 'id'],
    }),
  }, guard(async ({ entity, id, branch }) => gitCall(async () => {
    const kind = GIT_ENTITIES[entity]
    if (!kind) return failure(`entity must be one of ${GIT_ENTITY_KINDS.join(', ')}.`)
    if (!kind.syncState) return failure(`Linkr does not track the remote state of a ${entity}; use get_git_status.`)
    return text(formatSyncState(await api.request<GitSyncState>('GET', gitPath(entity, id, 'sync-state', branch))))
  })))

  server.registerTool('list_git_branches', {
    description: 'The branches of the git remote a Linkr entity is linked to.',
    annotations: REMOTE_READ,
    inputSchema: fromJsonSchema<{ entity: GitEntity; id: string }>({
      type: 'object', properties: entitySchema, required: ['entity', 'id'],
    }),
  }, guard(async ({ entity, id }) => gitCall(async () => {
    if (!GIT_ENTITIES[entity]) return failure(`entity must be one of ${GIT_ENTITY_KINDS.join(', ')}.`)
    return text(formatBranches(await api.request<GitBranches>('GET', gitPath(entity, id, 'branches'))))
  })))
}
