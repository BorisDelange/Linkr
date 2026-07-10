import { create } from 'zustand'
import { getApiBaseUrl, isServerMode } from '@/lib/api-client'

export interface AuthUser {
  id: number
  username: string
  email: string | null
  role: string
  is_active: boolean
  // Global-tier permissions the user's role grants (from GET /auth/me). Present
  // after validateToken; absent right after login (login returns the lighter
  // user shape), so gate on hasGlobalPermission which treats absence as "no".
  permissions?: string[]
}

interface AuthState {
  isServerMode: boolean
  token: string | null
  refreshToken: string | null
  user: AuthUser | null
  needsSetup: boolean | null // null = not yet checked
  isCheckingAuth: boolean
  serverUnreachable: boolean // server mode + backend didn't answer the setup check
  loginError: string | null

  checkSetupStatus: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
  validateToken: () => Promise<boolean>
  setTokens: (accessToken: string, refreshToken: string, user: AuthUser) => void
}

function loadStoredAuth(): { token: string | null; refreshToken: string | null; user: AuthUser | null } {
  if (!isServerMode()) return { token: null, refreshToken: null, user: null }
  const token = localStorage.getItem('linkr-access-token')
  const refreshToken = localStorage.getItem('linkr-refresh-token')
  const userStr = localStorage.getItem('linkr-auth-user')
  let user: AuthUser | null = null
  if (userStr) {
    try {
      user = JSON.parse(userStr)
    } catch {
      // ignore
    }
  }
  return { token, refreshToken, user }
}

/**
 * True if the current user's global role grants `permission` (e.g.
 * "users:read", "app-database:read"). In front-only mode there is no auth, so
 * everything is permitted. Absence of the permission list (or no user) → false.
 */
export function hasGlobalPermission(permission: string): boolean {
  if (!isServerMode()) return true
  const user = useAuthStore.getState().user
  if (user?.role === 'admin') return true // hard super-admin, mirrors the backend
  return !!user?.permissions?.includes(permission)
}

/** Reactive variant of hasGlobalPermission for use inside components. */
export function useHasGlobalPermission(permission: string): boolean {
  const user = useAuthStore((s) => s.user)
  if (!isServerMode()) return true
  if (user?.role === 'admin') return true // hard super-admin, mirrors the backend
  return !!user?.permissions?.includes(permission)
}

export const useAuthStore = create<AuthState>()((set, get) => {
  const stored = loadStoredAuth()

  return {
    isServerMode: isServerMode(),
    token: stored.token,
    refreshToken: stored.refreshToken,
    user: stored.user,
    needsSetup: null,
    isCheckingAuth: false,
    serverUnreachable: false,
    loginError: null,

    checkSetupStatus: async () => {
      if (!isServerMode()) return
      set({ isCheckingAuth: true })
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/v1/setup/status`)
        if (res.ok) {
          const data = await res.json()
          set({ needsSetup: data.needs_setup, isCheckingAuth: false, serverUnreachable: false })
        } else {
          // The server answered (even with an error) — it's reachable.
          set({ needsSetup: false, isCheckingAuth: false, serverUnreachable: false })
        }
      } catch {
        // The backend didn't answer at all (down, wrong URL, refused to boot, CORS):
        // flag it so the gate shows a dedicated "server unreachable" screen instead
        // of a login form that can only fail with a misleading error.
        set({ needsSetup: false, isCheckingAuth: false, serverUnreachable: true })
      }
    },

    login: async (username: string, password: string) => {
      set({ loginError: null })
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })

        if (!res.ok) {
          // 401 = bad credentials (i18n-mapped in the UI); anything else surfaces
          // the server's own detail so the user sees the real reason.
          set({ loginError: res.status === 401 ? 'invalid_credentials' : 'server_error' })
          return false
        }

        const data = await res.json()
        get().setTokens(data.access_token, data.refresh_token, data.user)
        // Login returns the light user shape (no permissions); refresh from
        // /auth/me so the UI can gate admin surfaces without a page reload.
        await get().validateToken()
        return true
      } catch {
        set({ loginError: 'unreachable' })
        return false
      }
    },

    logout: () => {
      localStorage.removeItem('linkr-access-token')
      localStorage.removeItem('linkr-refresh-token')
      localStorage.removeItem('linkr-auth-user')
      set({ token: null, refreshToken: null, user: null })
    },

    validateToken: async () => {
      const { token } = get()
      if (!token) return false

      try {
        const res = await fetch(`${getApiBaseUrl()}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (res.ok) {
          const user = await res.json()
          set({ user })
          return true
        }

        // Try refresh
        const refreshToken = get().refreshToken
        if (!refreshToken) {
          get().logout()
          return false
        }

        const refreshRes = await fetch(`${getApiBaseUrl()}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        })

        if (refreshRes.ok) {
          const data = await refreshRes.json()
          get().setTokens(data.access_token, data.refresh_token, data.user)
          return true
        }

        get().logout()
        return false
      } catch {
        return false
      }
    },

    setTokens: (accessToken: string, refreshToken: string, user: AuthUser) => {
      localStorage.setItem('linkr-access-token', accessToken)
      localStorage.setItem('linkr-refresh-token', refreshToken)
      localStorage.setItem('linkr-auth-user', JSON.stringify(user))
      set({ token: accessToken, refreshToken, user, loginError: null })
    },
  }
})
