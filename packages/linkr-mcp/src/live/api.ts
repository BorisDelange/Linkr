/**
 * REST client for a running Linkr server, acting as one user.
 *
 * Every call goes through the public API, so the server re-checks the caller's
 * permissions on each one: the agent can never do more than the user whose
 * credentials it holds.
 *
 * Credentials, read from the environment:
 * - `LINKR_API_URL`  — e.g. http://localhost:8000 (no `/api/v1`)
 * - `LINKR_TOKEN`    — an access token, or
 * - `LINKR_USERNAME` + `LINKR_PASSWORD` — logged in on first use, refreshed on 401.
 */
import type {
  Cohort, ConceptList, ConceptMapping, ConceptSet, Dashboard, DashboardTab, DashboardWidget, MappingProject,
  MappingProjectStats, SchemaMapping, ScoresIndex,
} from '@/types'
import type { DerivePlanTable, DeriveRequest } from '@/lib/api/data-sources'
import type { Job } from '@/lib/api/environments'
import type { ExecutionOutput, RunLanguage } from './ide.js'

export interface Project {
  uid: string
  entityId?: string | null
  workspaceId?: string | null
  name: Record<string, string>
  description: Record<string, string>
  shortDescription?: Record<string, string>
  linkedDataSourceIds?: string[] | null
}

export interface DataSource {
  id: string
  entityId?: string | null
  lineageId?: string | null
  workspaceId?: string | null
  alias: string
  name: Record<string, string> | string
  description?: Record<string, string> | string | null
  sourceType: string
  status: string
  schemaMapping?: SchemaMapping | null
  version?: string | null
  schemaSource?: { label?: Record<string, string> | string | null } | null
  stats?: Record<string, unknown> | null
}

export interface CurrentUser {
  id: number
  username: string
  firstName?: string | null
  lastName?: string | null
}

/** A precomputed or agent suggestion, as the scores endpoints return it. */
export interface ScoreRow {
  source_vocabulary_id: string
  source_concept_code: string
  concept_id: number
  method: string
  score: number
  equivalence: string
  comment: string | null
  created_at: string | null
  concept_set_uid: string | null
  concept_set_source_repo: string | null
}

/** The index the scores endpoints return: source keys are `vocabulary::code`. */
export type ServerScoresIndex = Omit<ScoresIndex, 'sourceKeys' | 'categorySourceKeys'> & {
  sourceKeys: string[]
  categorySourceKeys: Record<string, string[]>
}

export interface IntrospectedTable {
  name: string
  columns: { name: string; type: string; nullable: boolean }[]
}

export interface DatasetNode {
  id: string
  name: string
  type: 'file' | 'folder'
  path: string
  columns?: ({ id: string; name: string; type: string; label?: string; description?: string } & Record<string, unknown>)[] | null
  rowCount?: number | null
}

export interface IdeFile {
  id: string
  name: string
  type: 'file' | 'folder'
  path: string
  language?: string | null
  content?: string | null
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class LinkrApi {
  private readonly env: NodeJS.ProcessEnv
  private accessToken: string | undefined
  private refreshToken: string | undefined

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
    this.accessToken = env.LINKR_TOKEN || undefined
  }

  /** Checked per call rather than at start-up, so a client that registers the
   *  server without configuring it sees the reason on the first tool call
   *  instead of a server that failed to start. */
  private get base(): string {
    const url = this.env.LINKR_API_URL?.replace(/\/+$/, '')
    if (!url) throw new Error('LINKR_API_URL is not set (e.g. http://localhost:8000) — see packages/linkr-mcp/.env.example.')
    return `${url}/api/v1`
  }

  private async login(): Promise<void> {
    const username = this.env.LINKR_USERNAME
    const password = this.env.LINKR_PASSWORD
    if (!username || !password) {
      throw new Error('No credentials: set LINKR_TOKEN, or LINKR_USERNAME and LINKR_PASSWORD.')
    }
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) throw new ApiError(res.status, `Login failed (${res.status}).`)
    const body = await res.json() as { access_token: string; refresh_token: string }
    this.accessToken = body.access_token
    this.refreshToken = body.refresh_token
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false
    const res = await fetch(`${this.base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    })
    if (!res.ok) return false
    const body = await res.json() as { access_token: string; refresh_token: string }
    this.accessToken = body.access_token
    this.refreshToken = body.refresh_token
    return true
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    if (!this.accessToken) await this.login()
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        // Marks the write as an agent's, so the server notifies the user's open tabs.
        'X-Linkr-Client': 'mcp',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && !retried) {
      // An expired access token: refresh, or log in again when that is not possible.
      if (!(await this.refresh())) {
        this.accessToken = undefined
        if (!this.env.LINKR_USERNAME) throw new ApiError(401, 'The Linkr token was rejected (expired?).')
      }
      return this.request(method, path, body, true)
    }
    if (!res.ok) {
      let detail = res.statusText
      try {
        const payload = await res.json() as { detail?: unknown }
        if (payload.detail !== undefined) {
          detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail)
        }
      } catch { /* not JSON */ }
      throw new ApiError(res.status, detail)
    }
    if (res.status === 204) return undefined as T
    return await res.json() as T
  }

  listProjects = () => this.request<Project[]>('GET', '/projects')
  getProject = (uid: string) => this.request<Project>('GET', `/projects/${encodeURIComponent(uid)}`)

  listDataSources = () => this.request<DataSource[]>('GET', '/data-sources')
  getDataSource = (id: string) => this.request<DataSource>('GET', `/data-sources/${encodeURIComponent(id)}`)
  getSchema = (id: string) =>
    this.request<IntrospectedTable[]>('GET', `/data-sources/${encodeURIComponent(id)}/schema`)
  query = async (id: string, sql: string) =>
    (await this.request<{ rows: Record<string, unknown>[] }>(
      'POST', `/data-sources/${encodeURIComponent(id)}/query`, { sql },
    )).rows

  listCohorts = (projectUid: string) =>
    this.request<Cohort[]>('GET', `/cohorts?projectUid=${encodeURIComponent(projectUid)}`)
  getCohort = (id: string) => this.request<Cohort>('GET', `/cohorts/${encodeURIComponent(id)}`)
  createCohort = (body: Record<string, unknown>) => this.request<Cohort>('POST', '/cohorts', body)
  updateCohort = (id: string, changes: Record<string, unknown>) =>
    this.request<Cohort>('PATCH', `/cohorts/${encodeURIComponent(id)}`, changes)
  deleteCohort = (id: string) => this.request<void>('DELETE', `/cohorts/${encodeURIComponent(id)}`)

  getUiContext = () => this.request<Record<string, unknown> | null>('GET', '/notifications/ui-context')

  listDatasets = (projectUid: string) =>
    this.request<DatasetNode[]>('GET', `/dataset-files?projectUid=${encodeURIComponent(projectUid)}`)
  getDatasetMeta = (projectUid: string, path: string) =>
    this.request<DatasetNode>(
      'GET', `/dataset-files/meta?projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(path)}`,
    )
  getColumnStats = (projectUid: string, path: string, colId: string) =>
    this.request<Record<string, unknown>>(
      'GET',
      `/dataset-files/columns/${encodeURIComponent(colId)}/stats?projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(path)}`,
    )
  queryDatasetRows = (projectUid: string, path: string, limit: number) =>
    this.request<{ rows: Record<string, unknown>[]; total: number }>(
      'POST', `/dataset-files/rows/query?projectUid=${encodeURIComponent(projectUid)}&path=${encodeURIComponent(path)}`,
      { offset: 0, limit },
    )
  datasetOps = (projectUid: string, path: string, ops: Record<string, unknown>[]) =>
    this.request<{ node: DatasetNode }>('POST', '/dataset-files/ops', { projectUid, path, ops })
  setColumnMeta = (projectUid: string, path: string, columns: Record<string, Record<string, unknown>>) =>
    this.request<DatasetNode>('POST', '/dataset-files/columns/meta', { projectUid, path, columns })
  duplicateDataset = (projectUid: string, path: string, newName: string) =>
    this.request<DatasetNode>('POST', '/dataset-files/duplicate', { projectUid, path, newName })
  moveDataset = (projectUid: string, path: string, newPath: string) =>
    this.request<void>('POST', '/dataset-files/move', { projectUid, path, newPath })
  deleteDataset = (projectUid: string, path: string) =>
    this.request<void>('POST', '/dataset-files/delete', { projectUid, path })
  datasetFromQuery = (body: { projectUid: string; path: string; dataSourceId: string; sql: string; replace: boolean }) =>
    this.request<DatasetNode>('POST', '/dataset-files/from-query', body)

  listDashboards = (projectUid: string) =>
    this.request<Dashboard[]>('GET', `/dashboards?projectUid=${encodeURIComponent(projectUid)}`)
  getDashboard = (id: string) => this.request<Dashboard>('GET', `/dashboards/${encodeURIComponent(id)}`)
  createDashboard = (body: Record<string, unknown>) => this.request<Dashboard>('POST', '/dashboards', body)
  updateDashboard = (id: string, changes: Record<string, unknown>) =>
    this.request<Dashboard>('PATCH', `/dashboards/${encodeURIComponent(id)}`, changes)
  deleteDashboard = (id: string) => this.request<void>('DELETE', `/dashboards/${encodeURIComponent(id)}`)
  listTabs = (dashboardId: string) =>
    this.request<DashboardTab[]>('GET', `/dashboards/${encodeURIComponent(dashboardId)}/tabs`)
  getTab = (id: string) => this.request<DashboardTab>('GET', `/dashboards/tabs/${encodeURIComponent(id)}`)
  createTab = (body: Record<string, unknown>) => this.request<DashboardTab>('POST', '/dashboards/tabs', body)
  updateTab = (id: string, changes: Record<string, unknown>) =>
    this.request<DashboardTab>('PATCH', `/dashboards/tabs/${encodeURIComponent(id)}`, changes)
  deleteTab = (id: string) => this.request<void>('DELETE', `/dashboards/tabs/${encodeURIComponent(id)}`)
  listWidgets = (tabId: string) =>
    this.request<DashboardWidget[]>('GET', `/dashboards/tabs/${encodeURIComponent(tabId)}/widgets`)
  getWidget = (id: string) => this.request<DashboardWidget>('GET', `/dashboards/widgets/${encodeURIComponent(id)}`)
  createWidget = (body: Record<string, unknown>) => this.request<DashboardWidget>('POST', '/dashboards/widgets', body)
  updateWidget = (id: string, changes: Record<string, unknown>) =>
    this.request<DashboardWidget>('PATCH', `/dashboards/widgets/${encodeURIComponent(id)}`, changes)
  deleteWidget = (id: string) => this.request<void>('DELETE', `/dashboards/widgets/${encodeURIComponent(id)}`)

  listScripts = (projectUid: string) =>
    this.request<IdeFile[]>('GET', `/ide-files?projectUid=${encodeURIComponent(projectUid)}`)
  createScript = (projectUid: string, path: string, content: string, type: 'file' | 'folder' = 'file') =>
    this.request<IdeFile>('POST', '/ide-files', { projectUid, path, type, content })
  saveScript = (projectUid: string, path: string, content: string) =>
    this.request<void>('PUT', '/ide-files/content', { projectUid, path, content })
  moveScript = (projectUid: string, path: string, newPath: string) =>
    this.request<void>('POST', '/ide-files/move', { projectUid, path, newPath })
  deleteScript = (projectUid: string, path: string) =>
    this.request<void>('POST', '/ide-files/delete', { projectUid, path })
  execute = (body: {
    projectUid: string; language: RunLanguage; code: string; sessionId?: string
    datasetFileId?: string; connectionId?: string; label?: string
  }) => this.request<ExecutionOutput>('POST', '/execute', body)

  listConceptSets = (workspaceId?: string) =>
    this.request<ConceptSet[]>('GET', `/concept-sets${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)
  getConceptSet = (id: string) => this.request<ConceptSet>('GET', `/concept-sets/${encodeURIComponent(id)}`)
  listConceptLists = (projectUid: string) =>
    this.request<ConceptList[]>('GET', `/concept-lists?projectUid=${encodeURIComponent(projectUid)}`)
  getConceptList = (id: string) => this.request<ConceptList>('GET', `/concept-lists/${encodeURIComponent(id)}`)
  createConceptList = (body: Record<string, unknown>) => this.request<ConceptList>('POST', '/concept-lists', body)
  updateConceptList = (id: string, changes: Record<string, unknown>) =>
    this.request<ConceptList>('PATCH', `/concept-lists/${encodeURIComponent(id)}`, changes)
  deleteConceptList = (id: string) => this.request<void>('DELETE', `/concept-lists/${encodeURIComponent(id)}`)

  me = () => this.request<CurrentUser>('GET', '/auth/me')

  listMappingProjects = (workspaceId?: string) =>
    this.request<MappingProject[]>('GET', `/mapping-projects${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)
  getMappingProject = (id: string) => this.request<MappingProject>('GET', `/mapping-projects/${encodeURIComponent(id)}`)
  updateMappingProject = (id: string, changes: Record<string, unknown>) =>
    this.request<MappingProject>('PATCH', `/mapping-projects/${encodeURIComponent(id)}`, changes)
  /** SQL over the project's flat source, exposed as the `source_concepts` view. */
  queryMappingSource = (id: string, sql: string) =>
    this.request<Record<string, unknown>[]>('POST', `/mapping-projects/${encodeURIComponent(id)}/query`, { sql })
  listMappings = (id: string) => this.request<ConceptMapping[]>('GET', `/mapping-projects/${encodeURIComponent(id)}/mappings`)
  mappingStats = (id: string) => this.request<MappingProjectStats>('GET', `/mapping-projects/${encodeURIComponent(id)}/stats`)
  createMappings = (mappings: Record<string, unknown>[]) => this.request<void>('POST', '/concept-mappings/batch', { mappings })
  scoresIndex = (id: string) => this.request<ServerScoresIndex | null>('GET', `/mapping-projects/${encodeURIComponent(id)}/scores-index`)
  queryScores = (id: string, vocabularyId: string, conceptCode: string) =>
    this.request<ScoreRow[]>('POST', `/mapping-projects/${encodeURIComponent(id)}/scores/query`, { vocabularyId, conceptCode })
  appendScores = (id: string, rows: Record<string, unknown>[]) =>
    this.request<ServerScoresIndex & { added: number; skipped: number }>(
      'POST', `/mapping-projects/${encodeURIComponent(id)}/scores/append`, { rows },
    )

  // Derived databases, jobs
  listDatabaseCohorts = (dataSourceId: string) =>
    this.request<Cohort[]>('GET', `/cohorts?dataSourceId=${encodeURIComponent(dataSourceId)}`)
  createDataSource = (body: Record<string, unknown>) => this.request<DataSource>('POST', '/data-sources', body)
  deleteDataSource = (id: string) => this.request<void>('DELETE', `/data-sources/${encodeURIComponent(id)}`)
  derivePlan = (id: string, level: string) =>
    this.request<DerivePlanTable[]>('POST', `/data-sources/${encodeURIComponent(id)}/derive-plan`, { level })
  /** Starts the copy as a job of the database's workspace; returns it queued. */
  derive = (id: string, body: DeriveRequest) =>
    this.request<Job>('POST', `/data-sources/${encodeURIComponent(id)}/derive`, body)
  getJob = (id: string) => this.request<Job>('GET', `/jobs/${encodeURIComponent(id)}`)
  cancelJob = (id: string) => this.request<void>('POST', `/jobs/${encodeURIComponent(id)}/cancel`)
}
