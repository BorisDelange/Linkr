/** REST calls and shared helpers of the workspace, project and database tools. */
import { localized } from '@/lib/localized'
import { grainTable } from '@/lib/schema-classes/spec'
import type { CustomSchemaPreset, DataSource, DatabaseStatsCache, MappingProject, Project, Workspace } from '@/types'
import type { TestConnectionResult } from '@/lib/api/data-sources'
import { ApiError } from './api.js'
import { api } from './shared.js'
import { BADGE_COLORS, LANGUAGES, errorWords, isFileDatabase, retestUpdate, type Language } from './workspace.js'

const enc = encodeURIComponent
export const rest = {
  workspaces: () => api.request<Workspace[]>('GET', '/workspaces'),
  workspace: (id: string) => api.request<Workspace>('GET', `/workspaces/${enc(id)}`),
  createWorkspace: (body: Record<string, unknown>) => api.request<Workspace>('POST', '/workspaces', body),
  updateWorkspace: (id: string, changes: Record<string, unknown>) =>
    api.request<Workspace>('PATCH', `/workspaces/${enc(id)}`, changes),
  organizations: () => api.request<{ id: string; name: Record<string, string> | string; type?: string | null }[]>('GET', '/organizations'),
  projects: () => api.request<Project[]>('GET', '/projects'),
  project: (uid: string) => api.request<Project>('GET', `/projects/${enc(uid)}`),
  createProject: (body: Record<string, unknown>) => api.request<Project>('POST', '/projects', body),
  updateProject: (uid: string, changes: Record<string, unknown>) =>
    api.request<Project>('PATCH', `/projects/${enc(uid)}`, changes),
  databases: async () => (await api.listDataSources()) as unknown as DataSource[],
  database: async (id: string) => (await api.getDataSource(id)) as unknown as DataSource,
  createDatabase: (body: Record<string, unknown>) => api.request<DataSource>('POST', '/data-sources', body),
  updateDatabase: (id: string, changes: Record<string, unknown>) =>
    api.request<DataSource>('PATCH', `/data-sources/${enc(id)}`, changes),
  deleteDatabase: (id: string) => api.request<void>('DELETE', `/data-sources/${enc(id)}`),
  createFromDdl: (id: string, ddl: string, path?: string) =>
    api.request<DataSource>('POST', `/data-sources/${enc(id)}/create-from-ddl`, { ddl, ...(path ? { path } : {}) }),
  retest: (id: string) => api.request<TestConnectionResult>('POST', `/data-sources/${enc(id)}/retest`),
  statsCache: (id: string) =>
    api.request<{ computedAt: string; payload: Partial<DatabaseStatsCache> } | null>('GET', `/data-sources/${enc(id)}/stats-cache`),
  presets: () => api.request<CustomSchemaPreset[]>('GET', '/schema-presets'),
  mappingProjects: (workspaceId: string) => api.listMappingProjects(workspaceId) as Promise<MappingProject[]>,
  wikiPages: (workspaceId: string) => api.request<unknown[]>('GET', `/wiki-pages?workspaceId=${enc(workspaceId)}`),
}

export const name = (v: Record<string, string> | string | null | undefined, lang: Language = 'en') => localized(v, lang)
export const langOf = (l?: string): Language => (l === 'fr' ? 'fr' : 'en')

/** The workspace a call acts in: the one given, else the user's only one. */
export async function resolveWorkspace(workspaceId?: string): Promise<Workspace | string> {
  const all = await rest.workspaces()
  if (workspaceId) return all.find((w) => w.id === workspaceId) ?? `Unknown workspace_id ${workspaceId}: see list_workspaces.`
  if (all.length === 1) return all[0]
  return all.length === 0 ? 'No workspace accessible.' : 'Several workspaces: pass workspace_id (see list_workspaces).'
}

export async function findProject(uid: string): Promise<Project | string> {
  const all = await rest.projects()
  return all.find((p) => p.uid === uid) ?? `Unknown project_uid ${uid}: see list_projects.`
}

export async function findDatabase(id: string): Promise<DataSource | string> {
  const all = await rest.databases()
  return all.find((d) => d.id === id) ?? `Unknown database_id ${id}: see list_databases.`
}

export const linkedProjects = (projects: Project[], databaseId: string) =>
  projects.filter((p) => p.linkedDataSourceIds?.includes(databaseId)).map((p) => `"${name(p.name)}" (${p.uid})`)

/** Re-test a database as the app's Retest button does, and store the outcome. */
export async function retestAndStore(db: DataSource): Promise<{ db: DataSource; loginNeeded?: string }> {
  const file = isFileDatabase(db)
  let outcome: { ok: true; tableCount: number } | { ok: false; error: string }
  try {
    if (file) {
      outcome = { ok: true, tableCount: (await api.getSchema(db.id)).length }
    } else {
      const r = await rest.retest(db.id)
      outcome = r.ok ? { ok: true, tableCount: r.tables.length } : { ok: false, error: r.error ?? 'Connection failed' }
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 428) return { db, loginNeeded: e.message }
    outcome = { ok: false, error: (e as Error).message }
  }
  return { db: await rest.updateDatabase(db.id, retestUpdate(db, outcome, file)) }
}

export const statusLine = (db: DataSource) =>
  `status: ${db.status}${db.errorMessage ? ` (${errorWords(db.errorMessage)})` : ''}`
  + `${db.stats?.tableCount != null ? ` · ${db.stats.tableCount} tables` : ''}`

export async function countRows(db: DataSource): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const count = async (key: string, t: { table: string; schema?: string } | undefined) => {
    if (!t) return
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`
    try {
      const rows = await api.query(db.id, `SELECT COUNT(*) AS n FROM ${t.schema ? `${q(t.schema)}.` : ''}${q(t.table)}`)
      counts[key] = Number(rows[0]?.n ?? 0)
    } catch {
      counts[key] = 0
    }
  }
  const patient = grainTable(db.schemaMapping?.patient)
  if (patient) {
    await count('patientCount', patient)
    await count('visitCount', grainTable(db.schemaMapping?.visit))
  }
  return counts
}

export const LANGUAGE_PROP = {
  type: 'string', enum: LANGUAGES,
  description: 'Language of the texts you write (names, descriptions, README…). Default "en"; other languages are kept.',
} as const
export const BADGES_PROP = {
  type: 'array',
  description: 'The full list of badges wanted (replaces the current ones). A workspace category is written "Category::value". '
    + `Colours: ${BADGE_COLORS.join(', ')} or #hex; default the category's, else blue.`,
  items: { type: 'object', properties: { label: { type: 'string' }, color: { type: 'string' } }, required: ['label'] },
} as const

