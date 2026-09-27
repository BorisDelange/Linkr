/** What every tool module shares: the API client, result helpers, annotations. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import type { SchemaMapping, User } from '@/types'
import { userDisplayName, userToAuthorDetails } from '@/lib/user-identity'
import { ApiError, LinkrApi, type DataSource } from './api.js'

export type Server = McpServer

const envApi = new LinkrApi()
const requestApi = new AsyncLocalStorage<LinkrApi>()

/** Run `fn` with the API acting as the owner of a personal key (`lnk_…`): the
 *  HTTP entry serves each client as its own user. */
export const withApiToken = <T>(token: string, fn: () => T): T =>
  requestApi.run(new LinkrApi({ LINKR_API_URL: process.env.LINKR_API_URL, LINKR_TOKEN: token }), fn)

/** The Linkr API for the current call: the request's user over HTTP, else the
 *  credentials of the environment (stdio). */
export const api: LinkrApi = new Proxy({} as LinkrApi, {
  get: (_, key) => {
    const target = requestApi.getStore() ?? envApi
    const value = Reflect.get(target, key)
    // Bound, or a prototype method would run with the proxy as `this` and store
    // the login tokens on it instead of the client.
    return typeof value === 'function' ? value.bind(target) : value
  },
})

export type ToolResult = CallToolResult

export const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] })
/** Failure the model is meant to read and correct, not a server fault. */
export const failure = (body: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: body }] })

export const READ = { readOnlyHint: true, openWorldHint: false } as const
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

export const loc = (v: Record<string, string> | string | null | undefined) =>
  v == null ? '' : typeof v === 'string' ? v : v.en ?? v.fr ?? Object.values(v)[0] ?? ''

/** Run a tool body, turning API errors into readable failures. */
export const guard = <A>(fn: (args: A) => Promise<ToolResult>) => async (args: A): Promise<ToolResult> => {
  try {
    return await fn(args)
  } catch (e) {
    if (e instanceof ApiError) return failure(`Linkr API error ${e.status}: ${e.message}`)
    return failure((e as Error).message)
  }
}

/** Databases a project can query: linked, connected, and carrying a patient table. */
export async function projectDatabases(projectUid: string): Promise<DataSource[]> {
  const project = await api.getProject(projectUid)
  const linked = project.linkedDataSourceIds ?? []
  const all = await api.listDataSources()
  return all.filter((d) => linked.includes(d.id))
}

export interface WorkspaceScope { workspace_id?: string; project_uid?: string }

/** The workspace a tool is scoped to: workspace_id, else project_uid's workspace;
 *  undefined when neither is given. */
export async function scopedWorkspace({ workspace_id, project_uid }: WorkspaceScope): Promise<string | undefined> {
  if (workspace_id) return workspace_id
  if (!project_uid) return undefined
  const project = await api.getProject(project_uid)
  if (!project.workspaceId) throw new Error(`Project ${project_uid} belongs to no workspace.`)
  return project.workspaceId
}

/** `scopedWorkspace`, for a tool that needs one. */
export async function workspaceOf(scope: WorkspaceScope): Promise<string> {
  const workspaceId = await scopedWorkspace(scope)
  if (!workspaceId) throw new Error('Give workspace_id, or project_uid to use that project\'s workspace (list_projects lists the projects).')
  return workspaceId
}

/** The creator provenance the app stamps on a new entity (stampAuthored): the server does not. */
export async function authored() {
  const me = await api.request<User>('GET', '/auth/me')
  return { createdById: me.id, createdBy: userDisplayName(me), createdByDetails: userToAuthorDetails(me) }
}

export async function mappingOf(databaseId: string): Promise<SchemaMapping> {
  const ds = await api.getDataSource(databaseId)
  if (!ds.schemaMapping) throw new Error(`Database ${databaseId} has no schema mapping; cohorts cannot run on it.`)
  return ds.schemaMapping
}
/** Deleting: the client should ask the user first. */
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const
