/**
 * The access log (server mode): who read which database, ran which code, when,
 * from where, and how it went. Never result data. The whole log needs the
 * global `audit-log:read`; anyone reads their own through `listMyActivity`.
 */
import { apiFetch, apiRequest, ApiError } from '@/lib/api-client'
import type { DataTableQuery } from '@/components/ui/data-table'

export interface AuditEntry {
  seq: number
  at: string
  userId: number | null
  username: string | null
  /** 'web' | 'api_key' | 'kernel' | 'job:<id>' */
  via: string | null
  /** X-Linkr-Client of the caller, e.g. 'mcp'. */
  client: string | null
  method: string | null
  route: string | null
  status: number | null
  durationMs: number | null
  clientIp: string | null
  action: string | null
  workspaceId: string | null
  projectUid: string | null
  dataSourceId: string | null
  /** The SQL or code, truncated. */
  detail: string | null
  rowCount: number | null
  error: string | null
  /** `via` with every `job:<id>` folded into "job". */
  viaKind: string | null
  /** The SQL or code, else the route. */
  summary: string | null
  /** The action, else the HTTP method. */
  what: string | null
}

export interface AuditPage {
  entries: AuditEntry[]
  total: number
  /** Server column → the values its list filter offers, over the whole log. */
  filterOptions: Record<string, string[]>
}

export interface AuditVerifyResult {
  ok: boolean
  checked: number
  brokenAtSeq: number | null
}

/** Query-string for a DataTable server query. Column ids are the server's
 *  column names (see core/audit.VIEW_COLUMNS). */
export function auditQueryParams(q: Pick<DataTableQuery, 'sorting' | 'filters'> & Partial<DataTableQuery>): URLSearchParams {
  const params = new URLSearchParams()
  if (q.pageSize) {
    params.set('limit', String(q.pageSize))
    params.set('offset', String((q.page ?? 0) * q.pageSize))
  }
  if (q.sorting) {
    params.set('sort', q.sorting.columnId)
    params.set('desc', String(q.sorting.desc))
  }
  if (Object.keys(q.filters).length) params.set('filters', JSON.stringify(q.filters))
  return params
}

export const listAuditLog = (q: DataTableQuery) => apiRequest<AuditPage>(`/audit-log?${auditQueryParams(q)}`)

export const verifyAuditLog = () => apiRequest<AuditVerifyResult>('/audit-log/verify')

export const listMyActivity = (q: DataTableQuery) => apiRequest<AuditPage>(`/auth/my-activity?${auditQueryParams(q)}`)

/** Every entry matching the filters, as CSV, not just the page on screen. */
export async function exportAuditLog(q: Pick<DataTableQuery, 'sorting' | 'filters'>): Promise<Blob> {
  const res = await apiFetch(`/api/v1/audit-log/export?${auditQueryParams(q)}`)
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.blob()
}
