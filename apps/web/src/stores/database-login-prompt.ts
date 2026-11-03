import { create } from 'zustand'

/**
 * The one open "enter your own account for this database" prompt. Any request
 * the server answers 428 asks here and waits: requests hitting the same
 * database meanwhile share that prompt, prompts for different databases queue,
 * and every waiting request retries once the user saved a login (or gives up if
 * they dismissed it).
 */
/** What a login is for: the user's own account (`read`), or the one a cohort
 *  derivation writes SQL Server, Doris or Oracle with (`write`). */
export type LoginPurpose = 'read' | 'write'

interface PendingPrompt {
  dataSourceId: string
  sessionOnly: boolean
  purpose: LoginPurpose
}

interface DatabaseLoginPromptState {
  pending: PendingPrompt | null
  settle: (saved: boolean) => void
}

let resolveCurrent: ((saved: boolean) => void) | null = null
let queue: Promise<unknown> = Promise.resolve()
const waiters = new Map<string, Promise<boolean>>()

export const useDatabaseLoginPrompt = create<DatabaseLoginPromptState>((set) => ({
  pending: null,
  settle: (saved) => {
    const resolve = resolveCurrent
    resolveCurrent = null
    set({ pending: null })
    resolve?.(saved)
  },
}))

export function requestDatabaseLogin(dataSourceId: string, sessionOnly: boolean, purpose: LoginPurpose = 'read'): Promise<boolean> {
  const key = `${dataSourceId}:${purpose}`
  const existing = waiters.get(key)
  if (existing) return existing
  const promise = queue
    .then(() => new Promise<boolean>((resolve) => {
      resolveCurrent = resolve
      useDatabaseLoginPrompt.setState({ pending: { dataSourceId, sessionOnly, purpose } })
    }))
    .finally(() => waiters.delete(key))
  queue = promise.catch(() => undefined)
  waiters.set(key, promise)
  return promise
}

export interface CredentialRequiredDetail {
  code: 'database_credential_required'
  dataSourceId: string
  sessionOnly: boolean
  purpose: LoginPurpose
}

/** The 428 body's `detail`, when it is the "enter your own login" one. */
export function credentialRequiredDetail(body: unknown): CredentialRequiredDetail | null {
  const detail = (body as { detail?: unknown } | null)?.detail as Partial<CredentialRequiredDetail> | undefined
  if (!detail || detail.code !== 'database_credential_required' || typeof detail.dataSourceId !== 'string') return null
  return {
    code: detail.code, dataSourceId: detail.dataSourceId, sessionOnly: !!detail.sessionOnly,
    purpose: detail.purpose === 'write' ? 'write' : 'read',
  }
}
