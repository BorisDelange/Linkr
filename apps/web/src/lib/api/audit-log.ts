/**
 * The access log (server mode): who read which database, ran which code, when,
 * from where, and how it went. Never result data. The whole log needs the
 * global `audit-log:read`; anyone reads their own through `listMyActivity`.
 */
import { apiRequest } from '@/lib/api-client'

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
}

export interface AuditPage {
  entries: AuditEntry[]
  total: number
}

export interface AuditVerifyResult {
  ok: boolean
  checked: number
  brokenAtSeq: number | null
}

export const listAuditLog = (limit = 1000) => apiRequest<AuditPage>(`/audit-log?limit=${limit}`)

export const verifyAuditLog = () => apiRequest<AuditVerifyResult>('/audit-log/verify')

export const listMyActivity = (limit = 1000) => apiRequest<AuditPage>(`/auth/my-activity?limit=${limit}`)

const CSV_COLUMNS: (keyof AuditEntry)[] = [
  'seq', 'at', 'username', 'via', 'client', 'action', 'dataSourceId', 'projectUid', 'workspaceId',
  'method', 'route', 'status', 'rowCount', 'durationMs', 'clientIp', 'detail', 'error',
]

/** RFC 4180 CSV of the entries, for handing the log to a DPO. */
export function auditEntriesToCsv(entries: AuditEntry[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [CSV_COLUMNS.join(','), ...entries.map((e) => CSV_COLUMNS.map((c) => cell(e[c])).join(','))].join('\r\n')
}
