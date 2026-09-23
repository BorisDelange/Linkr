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
import type { Cohort, SchemaMapping } from '@/types'

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
  stats?: Record<string, unknown> | null
}

export interface IntrospectedTable {
  name: string
  columns: { name: string; type: string; nullable: boolean }[]
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
}
