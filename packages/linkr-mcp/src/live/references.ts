/**
 * Object references in tool arguments: every parameter that designates a project,
 * workspace, database, cohort or mapping project by its id also takes its name.
 * Applied once to the whole catalogue (`build.ts`), so each tool keeps reading ids.
 *
 * Names are only looked up in what the user's own listings return: an object the
 * user cannot see is never matched, nor named in an error. The server still checks
 * permissions on the call itself.
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { Cohort } from '@/types'
import type { LinkrApi } from './api.js'
import { inputJsonSchema, kindOf, type CatalogTool } from './gateway.js'
import { api, currentApi, failure, loc, projectDatabases } from './shared.js'

export type RefKind = 'project' | 'workspace' | 'database' | 'cohort' | 'mapping_project'

/** The kind each parameter designates. Projects come first: a cohort name is looked up
 *  in the project of the same call, once that one is resolved. */
export const REF_PARAMS: Record<string, RefKind> = {
  project_uid: 'project',
  link_to_project_uid: 'project',
  workspace_id: 'workspace',
  database_id: 'database',
  source_database_id: 'database',
  target_database_id: 'database',
  rebuild_database_id: 'database',
  cohort_id: 'cohort',
  mapping_project_id: 'mapping_project',
}

const KINDS: Record<RefKind, { noun: string; plural: string; listedBy: string }> = {
  project: { noun: 'project', plural: 'projects', listedBy: 'list_projects' },
  workspace: { noun: 'workspace', plural: 'workspaces', listedBy: 'list_workspaces' },
  database: { noun: 'database', plural: 'databases', listedBy: 'list_databases' },
  cohort: { noun: 'cohort', plural: 'cohorts', listedBy: 'list_cohorts' },
  mapping_project: { noun: 'mapping project', plural: 'mapping projects', listedBy: 'list_mapping_projects' },
}

const ORDER = Object.keys(KINDS) as RefKind[]
const SHOWN = 10
const TTL_MS = 30_000

/** An object as a reference can name it. `owner` is the project or database holding it. */
export interface Ref { id: string; label: string; names: string[]; owner?: string }

export interface Directory {
  list(kind: RefKind, fresh?: boolean): Promise<Ref[]>
  projectDatabases(projectUid: string): Promise<Ref[]>
}

type Named = Record<string, string> | string | null | undefined

function ref(id: string, name: Named, extra: { alias?: string; owner?: string | null } = {}): Ref {
  const names = name == null ? [] : typeof name === 'string' ? [name] : Object.values(name)
  if (extra.alias) names.push(extra.alias)
  return { id, label: loc(name) || id, names: [...new Set(names.filter(Boolean))], owner: extra.owner ?? undefined }
}

async function fetchRefs(kind: RefKind): Promise<Ref[]> {
  switch (kind) {
    case 'project':
      return (await api.listProjects()).map((p) => ref(p.uid, p.name))
    case 'workspace':
      return (await api.request<{ id: string; name: Named }[]>('GET', '/workspaces')).map((w) => ref(w.id, w.name))
    case 'database':
      return (await api.listDataSources()).map((d) => ref(d.id, d.name, { alias: d.alias }))
    case 'cohort':
      return (await api.request<Cohort[]>('GET', '/cohorts'))
        .map((c) => ref(c.id, c.name, { owner: c.projectUid ?? c.ownerDataSourceId }))
    case 'mapping_project':
      return (await api.listMappingProjects()).map((m) => ref(m.id, m.name))
  }
}

// Per user, briefly: a run of SQL calls on one database lists the databases once.
const cache = new WeakMap<LinkrApi, Map<RefKind, { at: number; refs: Promise<Ref[]> }>>()

export const liveDirectory: Directory = {
  list(kind, fresh = false) {
    const client = currentApi()
    const byKind = cache.get(client) ?? new Map()
    cache.set(client, byKind)
    const hit = byKind.get(kind)
    if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit.refs
    const refs = fetchRefs(kind)
    byKind.set(kind, { at: Date.now(), refs })
    refs.catch(() => byKind.delete(kind))
    return refs
  },
  projectDatabases: async (projectUid) =>
    (await projectDatabases(projectUid)).map((d) => ref(d.id, d.name, { alias: d.alias })),
}

const normalized = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

function listing(refs: Ref[], kind: RefKind): string {
  const shown = refs.slice(0, SHOWN).map((r) => `${r.label} (${r.id})`).join(', ')
  const more = refs.length - SHOWN
  return more > 0 ? `${shown}, and ${more} more (${KINDS[kind].listedBy} lists them all)` : shown
}

/** What `value` designates among `refs`: the object's id, an error naming the candidates
 *  when several match, or null when none does. Within `scope` (a project or database
 *  uid), the objects it holds win over same-named ones elsewhere. */
export function resolveRef(
  param: string, value: string, kind: RefKind, refs: Ref[], scope?: string,
): { id: string } | { error: string } | null {
  const v = value.trim()
  if (refs.some((r) => r.id === v)) return { id: v }
  const tests = [(n: string) => n.toLowerCase() === v.toLowerCase(), (n: string) => normalized(n) === normalized(v)]
  for (const test of tests) {
    let matches = refs.filter((r) => r.names.some(test))
    const inScope = matches.filter((r) => scope && r.owner === scope)
    if (inScope.length) matches = inScope
    if (matches.length === 1) return { id: matches[0].id }
    if (matches.length > 1) {
      return {
        error: `${param} "${value}" matches ${matches.length} ${KINDS[kind].plural}: ${listing(matches, kind)}. `
          + 'Give the id of the one you mean.',
      }
    }
  }
  return null
}

export function notFoundMessage(param: string, value: string, kind: RefKind, refs: Ref[], scope?: string): string {
  const { noun, plural } = KINDS[kind]
  const ordered = scope ? [...refs.filter((r) => r.owner === scope), ...refs.filter((r) => r.owner !== scope)] : refs
  const known = ordered.length
    ? `${plural[0].toUpperCase()}${plural.slice(1)} you can access: ${listing(ordered, kind)}.`
    : `You can access no ${noun}.`
  return `${param} "${value}" matches no ${noun} (by id or name). ${known}`
}

async function defaultDatabase(projectUid: unknown, dir: Directory): Promise<{ id: string } | { error: string }> {
  const linked = typeof projectUid === 'string' && projectUid
    ? await dir.projectDatabases(projectUid).catch(() => [])
    : []
  const candidates = linked.length ? linked : await dir.list('database')
  if (candidates.length === 1) return { id: candidates[0].id }
  if (candidates.length === 0) return { error: 'database_id is missing, and you can access no database.' }
  const who = linked.length ? 'this project links' : 'you can access'
  return {
    error: `database_id is missing, and ${who} ${candidates.length} databases: ${listing(candidates, 'database')}. `
      + 'Give database_id (an id or a name).',
  }
}

/** The arguments with every reference turned into an id, or the error to give the model. */
export async function resolveArguments(
  args: Record<string, unknown>, params: string[], defaultsDatabase: boolean, dir: Directory = liveDirectory,
): Promise<{ args: Record<string, unknown> } | { error: string }> {
  const out = { ...args }
  const ordered = [...params].sort((a, b) => ORDER.indexOf(REF_PARAMS[a]) - ORDER.indexOf(REF_PARAMS[b]))
  for (const param of ordered) {
    const value = out[param]
    if (typeof value !== 'string' || !value.trim()) continue
    const kind = REF_PARAMS[param]
    const scope = kind === 'cohort' ? String(out.project_uid ?? out.database_id ?? '') || undefined : undefined
    let refs: Ref[]
    let found
    try {
      refs = await dir.list(kind)
      found = resolveRef(param, value, kind, refs, scope)
      // Not in a listing up to TTL_MS old: it may have just been created.
      if (!found) {
        refs = await dir.list(kind, true)
        found = resolveRef(param, value, kind, refs, scope)
      }
    } catch {
      continue // No listing to check against: the call itself decides.
    }
    if (!found) return { error: notFoundMessage(param, value, kind, refs, scope) }
    if ('error' in found) return found
    out[param] = found.id
  }
  if (defaultsDatabase && (out.database_id == null || out.database_id === '')) {
    try {
      const found = await defaultDatabase(out.project_uid, dir)
      if ('error' in found) return found
      out.database_id = found.id
    } catch (e) {
      return { error: (e as Error).message }
    }
  }
  return { args: out }
}

const ID_OR_NAME = 'Id or name.'
const ID_OR_NAME_DEFAULT = 'Id or name; may be left out when only one database is available.'

/**
 * The tool taking names wherever it takes an id. A read tool that requires `database_id`
 * gets it optional, defaulting to the only database available; a tool that writes keeps
 * it required, so it never acts on a database the model did not name.
 */
export function withReferences(tool: CatalogTool, dir: Directory = liveDirectory): CatalogTool {
  const schema = structuredClone(inputJsonSchema(tool)) as {
    properties?: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
  const props = schema.properties ?? {}
  const params = Object.keys(props).filter((p) => REF_PARAMS[p] && props[p].type === 'string')
  if (params.length === 0 || !tool.config.inputSchema) return tool

  const defaultsDatabase = kindOf(tool.config.annotations) === 'read' && !!schema.required?.includes('database_id')
  for (const p of params) {
    const note = p === 'database_id' && defaultsDatabase ? ID_OR_NAME_DEFAULT : ID_OR_NAME
    props[p].description = props[p].description ? `${props[p].description} ${note}` : note
  }
  if (defaultsDatabase) schema.required = schema.required!.filter((p) => p !== 'database_id')

  return {
    ...tool,
    config: { ...tool.config, inputSchema: fromJsonSchema(schema) },
    handler: async (args) => {
      const resolved = await resolveArguments((args ?? {}) as Record<string, unknown>, params, defaultsDatabase, dir)
      return 'error' in resolved ? failure(resolved.error) : tool.handler(resolved.args)
    },
  }
}
