/** What every tool module shares: the API client, result helpers, annotations. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import type { SchemaMapping } from '@/types'
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
  get: (_, key) => Reflect.get(requestApi.getStore() ?? envApi, key),
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

export async function mappingOf(databaseId: string): Promise<SchemaMapping> {
  const ds = await api.getDataSource(databaseId)
  if (!ds.schemaMapping) throw new Error(`Database ${databaseId} has no schema mapping; cohorts cannot run on it.`)
  return ds.schemaMapping
}
/** Deleting: the client should ask the user first. */
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const
