/**
 * Object references in tool arguments: every parameter that designates a project,
 * workspace, database, cohort or mapping project by its id also takes its name.
 * Applied once to the whole catalogue (`build.ts`), so each tool keeps reading ids.
 *
 * Names are only looked up in what the user's own listings return: an object the
 * user cannot see is never matched, nor named in an error. A uuid is taken as an id
 * without a listing, and the server checks permissions on the call itself.
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { Cohort } from '@/types'
import { inputJsonSchema, kindOf, type CatalogTool } from './gateway.js'
import { api, currentCaller, failure, loc } from './shared.js'

export type RefKind = 'project' | 'workspace' | 'database' | 'cohort' | 'mapping_project'

/** The kind each parameter designates. Projects come first: a cohort or database name
 *  is looked up in the project of the same call, once that one is resolved. */
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

/** Parameters whose kind is the value of another one (`entity: "workspace", id: …`). */
export const TYPED_PARAMS: Record<string, string> = { id: 'entity', entity_id: 'entity_type' }

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
const MAX_CALLERS = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isKind = (v: unknown): v is RefKind => typeof v === 'string' && v in KINDS

/** An object as a reference can name it. `owner` is the project or database holding it. */
export interface Ref { id: string; label: string; names: string[]; owner?: string }

export interface Directory {
  /** The kind's objects, from a listing fetched at `notBefore` or later (default: within the TTL). */
  list(kind: RefKind, notBefore?: number): Promise<Ref[]>
  linkedDatabases(projectUid: string): Promise<string[]>
  /** Drops the current user's listings, after a call that may have changed them. */
  forget?(): void
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

/** Listings kept per user (`caller`) for TTL_MS: a run of SQL calls on one database lists
 *  the databases once. Expired entries and the least recent users beyond MAX_CALLERS go. */
export function cachedDirectory(
  fetch: (kind: RefKind) => Promise<Ref[]> = fetchRefs,
  caller: () => string = currentCaller,
): Directory {
  const byCaller = new Map<string, Map<RefKind, { at: number; refs: Promise<Ref[]> }>>()
  const sweep = (now: number) => {
    for (const [who, kinds] of byCaller) {
      for (const [kind, entry] of kinds) if (now - entry.at >= TTL_MS) kinds.delete(kind)
      if (kinds.size === 0) byCaller.delete(who)
    }
  }
  return {
    list(kind, notBefore) {
      const now = Date.now()
      sweep(now)
      const who = caller()
      const kinds = byCaller.get(who) ?? new Map()
      byCaller.delete(who)
      byCaller.set(who, kinds)
      const hit = kinds.get(kind)
      if (hit && hit.at >= (notBefore ?? now - TTL_MS)) return hit.refs
      const refs = fetch(kind)
      kinds.set(kind, { at: now, refs })
      refs.catch(() => { if (kinds.get(kind)?.refs === refs) kinds.delete(kind) })
      while (byCaller.size > MAX_CALLERS) byCaller.delete(byCaller.keys().next().value!)
      return refs
    },
    linkedDatabases: async (projectUid) => (await api.getProject(projectUid)).linkedDataSourceIds ?? [],
    forget() { byCaller.delete(caller()) },
  }
}

export const liveDirectory = cachedDirectory()

const normalized = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')

function listing(refs: Ref[], kind: RefKind): string {
  const shown = refs.slice(0, SHOWN).map((r) => `${r.label} (${r.id})`).join(', ')
  const more = refs.length - SHOWN
  return more > 0 ? `${shown}, and ${more} more (${KINDS[kind].listedBy} lists them all)` : shown
}

/** What `value` designates among `refs`: the object's id, an error naming the candidates
 *  when several match, or null when none does. Objects `inScope` (those of the project
 *  or database of the same call) win over same-named ones elsewhere. */
export function resolveRef(
  param: string, value: string, kind: RefKind, refs: Ref[], inScope?: (r: Ref) => boolean,
): { id: string } | { error: string } | null {
  const v = value.trim()
  if (refs.some((r) => r.id === v)) return { id: v }
  const tests = [
    (n: string) => n === v,
    (n: string) => n.toLowerCase() === v.toLowerCase(),
    (n: string) => normalized(n) === normalized(v),
  ]
  for (const test of tests) {
    let matches = refs.filter((r) => r.names.some(test))
    const scoped = inScope ? matches.filter(inScope) : []
    if (scoped.length) matches = scoped
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

export function notFoundMessage(
  param: string, value: string, kind: RefKind, refs: Ref[], inScope?: (r: Ref) => boolean,
): string {
  const { noun, plural } = KINDS[kind]
  const ordered = inScope ? [...refs.filter(inScope), ...refs.filter((r) => !inScope(r))] : refs
  const known = ordered.length
    ? `${plural[0].toUpperCase()}${plural.slice(1)} you can access: ${listing(ordered, kind)}.`
    : `You can access no ${noun}.`
  return `${param} "${value}" matches no ${noun} (by id or name). ${known}`
}

async function defaultDatabase(dir: Directory): Promise<{ id: string } | { error: string }> {
  const candidates = await dir.list('database')
  if (candidates.length === 1) return { id: candidates[0].id }
  if (candidates.length === 0) return { error: 'database_id is missing, and you can access no database.' }
  return {
    error: `database_id is missing, and you can access ${candidates.length} databases: ${listing(candidates, 'database')}. `
      + 'Give database_id (an id or a name).',
  }
}

const kindOfParam = (param: string, args: Record<string, unknown>): RefKind | undefined => {
  if (REF_PARAMS[param]) return REF_PARAMS[param]
  const kind = TYPED_PARAMS[param] && args[TYPED_PARAMS[param]]
  return isKind(kind) ? kind : undefined
}

/** The arguments with every reference turned into an id, or the error to give the model. */
export async function resolveArguments(
  args: Record<string, unknown>, params: string[], defaultsDatabase: boolean, dir: Directory = liveDirectory,
): Promise<{ args: Record<string, unknown> } | { error: string }> {
  const started = Date.now()
  const out = { ...args }
  const rank = (p: string) => (REF_PARAMS[p] ? ORDER.indexOf(REF_PARAMS[p]) : ORDER.length)
  for (const param of [...params].sort((a, b) => rank(a) - rank(b))) {
    const value = out[param]
    const kind = kindOfParam(param, out)
    if (typeof value !== 'string' || !value.trim() || !kind) continue
    if (UUID.test(value.trim())) {
      out[param] = value.trim()
      continue
    }
    const owner = kind === 'cohort' ? String(out.project_uid ?? out.database_id ?? '') : ''
    let inScope = owner ? (r: Ref) => r.owner === owner : undefined
    let refs: Ref[]
    let found
    try {
      refs = await dir.list(kind)
      found = resolveRef(param, value, kind, refs, inScope)
      // Not in a listing fetched before this call: it may have just been created.
      if (!found) {
        refs = await dir.list(kind, started)
        found = resolveRef(param, value, kind, refs, inScope)
      }
      if (found && 'error' in found && kind === 'database' && typeof out.project_uid === 'string') {
        const linked = await dir.linkedDatabases(out.project_uid).catch(() => [] as string[])
        inScope = (r: Ref) => linked.includes(r.id)
        found = resolveRef(param, value, kind, refs, inScope)
      }
    } catch {
      continue // No listing to check against: the call itself decides.
    }
    if (!found) return { error: notFoundMessage(param, value, kind, refs, inScope) }
    if ('error' in found) return found
    out[param] = found.id
  }
  if (defaultsDatabase && (out.database_id == null || out.database_id === '')) {
    try {
      const found = await defaultDatabase(dir)
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

type Props = Record<string, { type?: string; enum?: unknown[]; description?: string }>

/** The parameters of a schema that take a reference, with the note their description gets. */
function referenceParams(props: Props): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [p, prop] of Object.entries(props)) {
    if (prop.type !== 'string') continue
    if (REF_PARAMS[p]) found[p] = ID_OR_NAME
    const typedBy = TYPED_PARAMS[p] ? props[TYPED_PARAMS[p]] : undefined
    const kinds = (typedBy?.enum ?? []).filter(isKind)
    const nouns = kinds.map((k) => KINDS[k].noun)
    if (nouns.length) found[p] = `For a ${[nouns.slice(0, -1).join(', '), nouns.at(-1)].filter(Boolean).join(' or ')}, its name also works.`
  }
  return found
}

/**
 * The tool taking names wherever it takes an id. A read tool that requires `database_id`
 * gets it optional, defaulting to the only database available; a tool that writes keeps
 * it required, so it never acts on a database the model did not name. After a tool that
 * writes, the user's listings are dropped, so a name never resolves to a deleted object.
 */
export function withReferences(tool: CatalogTool, dir: Directory = liveDirectory): CatalogTool {
  const writes = kindOf(tool.config.annotations) !== 'read'
  const schema = structuredClone(inputJsonSchema(tool)) as { properties?: Props; required?: string[] }
  const props = schema.properties ?? {}
  const notes = referenceParams(props)
  const params = Object.keys(notes)
  if (params.length === 0 || !tool.config.inputSchema) {
    if (!writes) return tool
    return {
      ...tool,
      handler: async (args) => {
        try { return await tool.handler(args) } finally { dir.forget?.() }
      },
    }
  }

  const defaultsDatabase = !writes && !!schema.required?.includes('database_id')
  for (const p of params) {
    const note = p === 'database_id' && defaultsDatabase ? ID_OR_NAME_DEFAULT : notes[p]
    props[p].description = props[p].description ? `${props[p].description} ${note}` : note
  }
  if (defaultsDatabase) schema.required = schema.required!.filter((p) => p !== 'database_id')

  return {
    ...tool,
    config: { ...tool.config, inputSchema: fromJsonSchema(schema) },
    handler: async (args) => {
      const resolved = await resolveArguments((args ?? {}) as Record<string, unknown>, params, defaultsDatabase, dir)
      if ('error' in resolved) return failure(resolved.error)
      try { return await tool.handler(resolved.args) } finally { if (writes) dir.forget?.() }
    },
  }
}
