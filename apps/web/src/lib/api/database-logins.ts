/**
 * Each user's own login to an external database (server mode). There is no
 * shared account: a database the user has no login for answers 428, and
 * `apiFetch` pauses the request until they enter one (see database-login-prompt).
 * The password is sent once, tested, and never comes back.
 */
import { apiRequest } from '@/lib/api-client'
import type { LocalizedString } from '@/types'

export interface DatabaseLoginStatus {
  hasLogin: boolean
  username: string | null
  /** False: held in server memory for this session only. */
  remembered: boolean
  lastUsedAt: string | null
  /** The database accepts session-only logins alone. */
  sessionOnly: boolean
}

export interface DatabaseLoginEntry {
  dataSourceId: string
  name: LocalizedString | string
  workspaceId: string | null
  username: string
  remembered: boolean
  lastUsedAt: string | null
}

export const getMyDatabaseLogin = (dataSourceId: string) =>
  apiRequest<DatabaseLoginStatus>(`/data-sources/${encodeURIComponent(dataSourceId)}/my-login`)

export const saveMyDatabaseLogin = (dataSourceId: string, username: string, password: string, remember: boolean) =>
  apiRequest<DatabaseLoginStatus>(`/data-sources/${encodeURIComponent(dataSourceId)}/my-login`, {
    method: 'PUT',
    body: JSON.stringify({ username, password, remember }),
  })

export const forgetMyDatabaseLogin = (dataSourceId: string) =>
  apiRequest<void>(`/data-sources/${encodeURIComponent(dataSourceId)}/my-login`, { method: 'DELETE' })

export const listMyDatabaseLogins = () => apiRequest<DatabaseLoginEntry[]>('/auth/database-logins')

export const countDatabaseLogins = (dataSourceId: string) =>
  apiRequest<{ count: number }>(`/data-sources/${encodeURIComponent(dataSourceId)}/login-count`)
