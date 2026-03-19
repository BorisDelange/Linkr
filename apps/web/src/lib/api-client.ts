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
  // In prod, VITE_API_URL points to the backend
  return import.meta.env.VITE_API_URL || ''
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
