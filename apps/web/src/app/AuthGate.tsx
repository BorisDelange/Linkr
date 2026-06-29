import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { LoginPage } from '@/features/login/LoginPage'
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

  // Validate stored token on mount (if we have one and setup is done)
  useEffect(() => {
    if (!(isServerMode && needsSetup === false && token && !user)) return
    let cancelled = false
    const run = async () => {
      setValidatingToken(true)
      try {
        await validateToken()
      } finally {
        if (!cancelled) setValidatingToken(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [isServerMode, needsSetup, token, user, validateToken])

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
