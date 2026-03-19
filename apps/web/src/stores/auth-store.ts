import { create } from 'zustand'
import { getApiBaseUrl, isServerMode } from '@/lib/api-client'

export interface AuthUser {
  id: number
  username: string
  email: string | null
  role: string
  is_active: boolean
}

interface AuthState {
  isServerMode: boolean
  token: string | null
  refreshToken: string | null
  user: AuthUser | null
  needsSetup: boolean | null // null = not yet checked
  isCheckingAuth: boolean
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

export const useAuthStore = create<AuthState>()((set, get) => {
  const stored = loadStoredAuth()

  return {
    isServerMode: isServerMode(),
    token: stored.token,
    refreshToken: stored.refreshToken,
    user: stored.user,
    needsSetup: null,
    isCheckingAuth: false,
    loginError: null,

    checkSetupStatus: async () => {
      if (!isServerMode()) return
      set({ isCheckingAuth: true })
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/v1/setup/status`)
        if (res.ok) {
          const data = await res.json()
          set({ needsSetup: data.needs_setup, isCheckingAuth: false })
        } else {
          set({ needsSetup: false, isCheckingAuth: false })
        }
      } catch {
        // Backend unreachable — assume no setup needed (will show error elsewhere)
        set({ needsSetup: false, isCheckingAuth: false })
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
          const data = await res.json().catch(() => ({}))
          set({ loginError: data.detail || 'Login failed' })
          return false
        }

        const data = await res.json()
        get().setTokens(data.access_token, data.refresh_token, data.user)
        return true
      } catch {
        set({ loginError: 'Cannot connect to server' })
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
