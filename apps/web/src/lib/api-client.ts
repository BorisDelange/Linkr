/**
 * API client for server mode.
 * Wraps fetch with JWT auth headers and automatic token refresh.
 */

let refreshPromise: Promise<boolean> | null = null

export function isServerMode(): boolean {
  return !!import.meta.env.VITE_API_URL
}

export function getApiBaseUrl(): string {
  // In dev, Vite proxy handles /api/* → localhost:8000
  // In prod, VITE_API_URL points to the backend.
  // Strip a trailing slash so callers can join `${base}/api/v1/...` without a
  // double slash — notably VITE_API_URL="/" (server mode, nginx routes relative
  // paths) must yield "" here, not "/".
  return (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
}

function getStoredToken(): string | null {
  return localStorage.getItem('linkr-access-token')
}

function getStoredRefreshToken(): string | null {
  return localStorage.getItem('linkr-refresh-token')
}

function clearStoredTokens(): void {
  localStorage.removeItem('linkr-access-token')
  localStorage.removeItem('linkr-refresh-token')
  localStorage.removeItem('linkr-auth-user')
}

function setStoredTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem('linkr-access-token', accessToken)
  localStorage.setItem('linkr-refresh-token', refreshToken)
}

async function refreshTokens(): Promise<boolean> {
  const refreshToken = getStoredRefreshToken()
  if (!refreshToken) return false

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!res.ok) {
      clearStoredTokens()
      return false
    }

    const data = await res.json()
    setStoredTokens(data.access_token, data.refresh_token)
    localStorage.setItem('linkr-auth-user', JSON.stringify(data.user))
    return true
  } catch {
    clearStoredTokens()
    return false
  }
}

/**
 * Fetch wrapper that adds Authorization header and handles 401 with token refresh.
 * Use for all authenticated API calls in server mode.
 */
export async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${getApiBaseUrl()}${path}`
  const token = getStoredToken()

  const headers = new Headers(options.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  let res = await fetch(url, { ...options, headers })

  // On 401, attempt token refresh once
  if (res.status === 401 && getStoredRefreshToken()) {
    // Use lock to prevent concurrent refresh attempts
    if (!refreshPromise) {
      refreshPromise = refreshTokens().finally(() => {
        refreshPromise = null
      })
    }

    const refreshed = await refreshPromise
    if (refreshed) {
      const retryHeaders = new Headers(options.headers)
      retryHeaders.set('Authorization', `Bearer ${getStoredToken()}`)
      if (!retryHeaders.has('Content-Type') && options.body && typeof options.body === 'string') {
        retryHeaders.set('Content-Type', 'application/json')
      }
      res = await fetch(url, { ...options, headers: retryHeaders })
    }
  }

  return res
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Human-readable rendering of an error, split so the UI can show a short
 *  summary up-front and keep the (often huge) raw payload behind a toggle.
 *  When `summaryKey` is set the caller translates it with `summaryCount`;
 *  otherwise `summary` holds a ready-to-display (server-supplied) string. */
export interface FormattedError {
  summary?: string
  /** i18n key for a count-based summary (e.g. validation errors). */
  summaryKey?: string
  /** Interpolation count for `summaryKey`. */
  summaryCount?: number
  /** Full technical detail (raw body / stack), or null when there's nothing extra. */
  detail: string | null
}

/**
 * Turn an arbitrary thrown value into a short summary + collapsible detail.
 * FastAPI validation errors arrive as `{"detail":[{loc,msg,...}, …]}` — a raw
 * JSON blob that is unreadable in a dialog. We collapse it to a "N field(s)
 * rejected" i18n summary plus a per-field breakdown; anything else falls back
 * to its (server-supplied or raw) message.
 */
export function formatApiError(err: unknown): FormattedError {
  const raw = err instanceof Error ? err.message : String(err)
  try {
    const body = JSON.parse(raw)
    const detail = body?.detail
    if (Array.isArray(detail) && detail.length > 0 && detail[0]?.loc) {
      const lines = detail.map((d: { loc?: unknown[]; msg?: string }) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : ''
        return field ? `${field}: ${d.msg ?? ''}` : (d.msg ?? '')
      })
      return {
        summaryKey: 'common.import_error_fields_rejected',
        summaryCount: detail.length,
        detail: lines.join('\n'),
      }
    }
    if (typeof detail === 'string') return { summary: detail, detail: null }
  } catch {
    // not JSON — fall through to the raw message
  }
  return { summary: raw, detail: null }
}

/**
 * Typed JSON request helper for API entity storage adapters.
 * Prefixes /api/v1, adds auth + refresh via apiFetch, throws ApiError on failure.
 */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/v1${path}`, init)
  if (!res.ok) {
    throw new ApiError(res.status, await res.text())
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}
