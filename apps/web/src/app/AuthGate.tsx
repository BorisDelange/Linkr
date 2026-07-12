import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useAppStore } from '@/stores/app-store'
import { LoginPage } from '@/features/login/LoginPage'
import { ServerUnreachable } from '@/features/login/ServerUnreachable'
import { SetupWizard } from '@/features/setup/SetupWizard'
import { LinkrLogo } from '@/components/ui/linkr-logo'

interface AuthGateProps {
  children: React.ReactNode
}

/**
 * Top-level auth gate.
 * - Local mode: pass-through (renders children immediately)
 * - Server mode: checks setup status, shows wizard or login as needed
 */
export function AuthGate({ children }: AuthGateProps) {
  const {
    isServerMode,
    needsSetup,
    isCheckingAuth,
    serverUnreachable,
    token,
    user,
    checkSetupStatus,
    validateToken,
  } = useAuthStore()

  const [setupJustCompleted, setSetupJustCompleted] = useState(false)
  const [validatingToken, setValidatingToken] = useState(false)

  // Check setup status on mount (server mode only)
  useEffect(() => {
    if (isServerMode) checkSetupStatus()
  }, [isServerMode, checkSetupStatus])

  // Validate the stored token on mount (once setup is done). Runs whenever a
  // token is present — even if a user is already cached from localStorage —
  // because that cached user is a stale snapshot without the permissions list
  // (/auth/me refreshes it). Block the UI with a loader only when there's no
  // cached user; otherwise revalidate in the background so permissions hydrate
  // without a flicker.
  useEffect(() => {
    if (!(isServerMode && needsSetup === false && token)) return
    let cancelled = false
    const blocking = !user
    const run = async () => {
      if (blocking) setValidatingToken(true)
      try {
        await validateToken()
      } finally {
        if (!cancelled && blocking) setValidatingToken(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // Intentionally excludes `user`: this must run once per token, not re-fire
    // when validateToken updates the user (which would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isServerMode, needsSetup, token, validateToken])

  // Server mode: the app-store `user` (used by the profile page, display name, etc.)
  // must mirror the authenticated account — otherwise it keeps its local default
  // ("admin"), so the profile shows the wrong username after login/refresh.
  useEffect(() => {
    if (!isServerMode) return
    if (user) {
      useAppStore.getState().login({
        id: user.id,
        username: user.username,
        firstName: user.first_name ?? '',
        lastName: user.last_name ?? '',
        role: user.role,
        affiliation: user.affiliation ?? '',
        profession: user.profession ?? '',
        orcid: user.orcid ?? '',
      })
    } else {
      useAppStore.getState().logout()
    }
  }, [isServerMode, user])

  // In local mode, render children immediately (after hooks, to keep hook order stable)
  if (!isServerMode) return <>{children}</>

  // Loading state
  if (isCheckingAuth || needsSetup === null || validatingToken) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
        <LinkrLogo size={48} />
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Backend didn't answer the setup check — show a dedicated screen (with retry)
  // instead of a login form that can only fail with a misleading error.
  if (serverUnreachable) {
    return <ServerUnreachable />
  }

  // Setup wizard
  if (needsSetup) {
    return (
      <SetupWizard
        onComplete={() => {
          setSetupJustCompleted(true)
          checkSetupStatus()
        }}
      />
    )
  }

  // Login page (no valid token/user)
  if (!token || !user) {
    return <LoginPage setupJustCompleted={setupJustCompleted} />
  }

  // Authenticated — render app
  return <>{children}</>
}
