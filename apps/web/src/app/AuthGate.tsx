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

  // In local mode, render children immediately
  if (!isServerMode) return <>{children}</>

  // Check setup status on mount
  useEffect(() => {
    checkSetupStatus()
  }, [checkSetupStatus])

  // Validate stored token on mount (if we have one and setup is done)
  useEffect(() => {
    if (needsSetup === false && token && !user) {
      setValidatingToken(true)
      validateToken().finally(() => setValidatingToken(false))
    }
  }, [needsSetup, token, user, validateToken])

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
