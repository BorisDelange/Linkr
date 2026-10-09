import { apiRequest } from '@/lib/api-client'
import type { IntrospectedTable } from '@/lib/api/data-sources'

/**
 * Admin-only read-only access to the application's OWN database (Settings →
 * Application database → Query database). Server mode only — there is no central
 * app database in the static/WASM build.
 */

export async function queryAppDatabase(sql: string): Promise<Record<string, unknown>[]> {
  const res = await apiRequest<{ rows: Record<string, unknown>[] }>('/database/query', {
    method: 'POST',
    body: JSON.stringify({ sql }),
  })
  return res.rows
}

export function fetchAppDatabaseSchema(): Promise<IntrospectedTable[]> {
  return apiRequest<IntrospectedTable[]>('/database/schema')
}

export interface AppDatabaseInfo {
  engine: string
  /** Absolute file path (SQLite) or host:port/db (otherwise), never the password. */
  location: string
}

export function fetchAppDatabaseInfo(): Promise<AppDatabaseInfo> {
  return apiRequest<AppDatabaseInfo>('/database/info')
}
