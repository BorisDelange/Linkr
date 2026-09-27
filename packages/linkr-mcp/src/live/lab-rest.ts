/** The REST calls and lookups the lab tool modules share: dataset files, workspace plugins, the caller. */
import type { DatasetOp } from '@linkr/format'
import { userToAuthorDetails } from '@/lib/user-identity'
import type { PluginManifest } from '@/types/plugin'
import type { DatasetNode } from './api.js'
import type { DatasetColumn } from './lab.js'
import { listPatientPlugins, type PluginLanguage, type PluginScope } from './lab-extra.js'
import { findPlugin } from './plugins.js'
import { api } from './shared.js'

export const q = encodeURIComponent

export type DsNode = DatasetNode & { parseOptions?: Record<string, unknown> | null; ops?: DatasetOp[] | null }

export interface DatasetAnalysis {
  id: string; projectUid: string; datasetPath: string; name: string; type: string; config: Record<string, unknown>
}

export interface UserPluginRow {
  id: string; entityId?: string | null; workspaceId: string; files: Record<string, string>; version?: string
  lineageId?: string | null; readme?: unknown; updatedAt?: string
}

export const ds = {
  meta: (projectUid: string, path: string) =>
    api.request<DsNode>('GET', `/dataset-files/meta?projectUid=${q(projectUid)}&path=${q(path)}`),
  ops: (projectUid: string, path: string, ops: DatasetOp[], replace = false) =>
    api.request<{ node: DsNode; ops: DatasetOp[] }>('POST', '/dataset-files/ops', { projectUid, path, ops, replace }),
  rows: (projectUid: string, path: string, body: Record<string, unknown>) =>
    api.request<{ rows: Record<string, unknown>[]; total: number }>(
      'POST', `/dataset-files/rows/query?projectUid=${q(projectUid)}&path=${q(path)}`, body,
    ),
  distinct: (projectUid: string, path: string, colId: string, limit: number, search?: string) =>
    api.request<unknown>(
      'GET', `/dataset-files/columns/${q(colId)}/distinct?projectUid=${q(projectUid)}&path=${q(path)}&limit=${limit}`
        + (search ? `&search=${q(search)}` : ''),
    ),
  reimport: (projectUid: string, path: string, parseOptions: Record<string, unknown>) =>
    api.request<DsNode>('POST', '/dataset-files/reimport', { projectUid, path, parseOptions }),
  previewPath: (projectUid: string, path: string, parseOptions: Record<string, unknown>) =>
    api.request<{ columns: DatasetColumn[]; preview: Record<string, unknown>[]; rowCount: number; sheetNames?: string[] | null }>(
      'POST', '/dataset-files/preview-path', { projectUid, path, parseOptions },
    ),
  analyses: (projectUid: string, path: string) =>
    api.request<DatasetAnalysis[]>('GET', `/dataset-files/analyses?projectUid=${q(projectUid)}&path=${q(path)}`),
}


export const plugins = {
  list: (workspaceId: string) => api.request<UserPluginRow[]>('GET', `/user-plugins?workspaceId=${q(workspaceId)}`),
  get: (id: string) => api.request<UserPluginRow>('GET', `/user-plugins/${q(id)}`),
  create: (body: Record<string, unknown>) => api.request<UserPluginRow>('POST', '/user-plugins', body),
  update: (id: string, body: Record<string, unknown>) => api.request<UserPluginRow>('PATCH', `/user-plugins/${q(id)}`, body),
  remove: (id: string) => api.request<void>('DELETE', `/user-plugins/${q(id)}`),
}

export async function me() {
  const user = await api.me()
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username
  return {
    by: String(user.id),
    authored: {
      createdById: user.id, createdBy: name,
      createdByDetails: userToAuthorDetails(user as unknown as Parameters<typeof userToAuthorDetails>[0]),
    },
  }
}

export function columnsOf(node: DsNode): (DatasetColumn & Record<string, unknown>)[] {
  return (node.columns ?? []) as (DatasetColumn & Record<string, unknown>)[]
}

export const colList = (cols: DatasetColumn[]) => cols.map((c) => c.name).join(', ')

/** A manifest parsed from a plugin row, or null when plugin.json is unreadable. */
export function manifestOf(row: UserPluginRow): PluginManifest | null {
  try { return JSON.parse(row.files['plugin.json'] ?? '') as PluginManifest } catch { return null }
}

/** Rows the app seeds from its own built-ins: listed, but their code is in the bundle. */
export const isBuiltinRow = (m: PluginManifest | null) => !!m?.id?.startsWith('linkr-')

export async function workspaceOfProject(projectUid: string): Promise<string | null> {
  return (await api.getProject(projectUid)).workspaceId ?? null
}

/** A plugin by manifest id: built-in first, then the workspace's own. */
export async function resolvePlugin(
  pluginId: string, scope: PluginScope, workspaceId: string | null,
): Promise<{ manifest: PluginManifest; templates: Record<string, string> } | null> {
  const builtIn = scope === 'lab'
    ? findPlugin(pluginId)
    : listPatientPlugins().find((p) => p.id === pluginId || p.id === `linkr-widget-${pluginId}`)
  if (builtIn) return { manifest: builtIn, templates: builtIn.templates ?? {} }
  if (!workspaceId) return null
  for (const row of await plugins.list(workspaceId)) {
    const m = manifestOf(row)
    if (!m || (m.id !== pluginId && row.id !== pluginId) || isBuiltinRow(m)) continue
    if ((m.scope ?? 'lab') !== scope) return null
    const templates: Record<string, string> = {}
    for (const [f, content] of Object.entries(row.files)) {
      if (f.endsWith('.py.template')) templates.python = content
      else if (f.endsWith('.R.template')) templates.r = content
    }
    return { manifest: m, templates }
  }
  return null
}

/** The language a script plugin runs in: the one asked for if it has a template,
 *  else Python when it has one, else R. Undefined for a component plugin. */
export function scriptLanguage(
  manifest: PluginManifest, templates: Record<string, string>, requested?: PluginLanguage,
): { language?: PluginLanguage; error?: string } {
  if (manifest.runtime?.includes('component') || Object.keys(templates).length === 0) return {}
  if (requested) {
    return templates[requested] ? { language: requested } : { error: `${manifest.id} has no ${requested} template (has: ${Object.keys(templates).join(', ')}).` }
  }
  return { language: templates.python ? 'python' : 'r' }
}
