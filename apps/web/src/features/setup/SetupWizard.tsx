import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Database,
  CheckCircle2,
  Loader2,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { LinkrLogo } from '@/components/ui/linkr-logo'
import { getApiBaseUrl } from '@/lib/api-client'

interface DbInfo {
  engine: string
  location: string
}

interface SetupWizardProps {
  onComplete: () => void
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState(1)

  // Step 1: the database is configured server-side (LINKR_DATABASE_URL); we
  // only display what the server actually runs on — read-only.
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)

  useEffect(() => {
    fetch(`${getApiBaseUrl()}/api/v1/setup/db-info`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setDbInfo(data))
      .catch(() => setDbInfo(null))
  }, [])

  // Step 2: Admin account
  // In dev, prefill admin/admin so first-run setup is one click. Empty in prod builds.
  const devDefault = import.meta.env.DEV ? 'admin' : ''
  const [username, setUsername] = useState(devDefault)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState(devDefault)
  const [confirmPassword, setConfirmPassword] = useState(devDefault)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirmPassword) return
    if (!username || !password) return

    setCreating(true)
    setCreateError('')
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/setup/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          email: email || null,
          password,
        }),
      })

      if (res.ok) {
        onComplete()
      } else {
        const data = await res.json().catch(() => ({}))
        setCreateError(data.detail || t('setup.error_generic'))
      }
    } catch {
      setCreateError(t('setup.error_generic'))
    } finally {
      setCreating(false)
    }
  }

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-lg px-4">
        {/* Logo + title */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <LinkrLogo size={48} />
          <h1 className="text-2xl font-bold text-foreground">{t('setup.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('setup.subtitle')}</p>
        </div>

        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          <StepDot active={step === 1} completed={step > 1} label="1" />
          <div className="h-px w-8 bg-border" />
          <StepDot active={step === 2} completed={false} label="2" />
        </div>

        {/* Step 1: Database */}
        {step === 1 && (
          <Card>
            <CardContent className="p-6">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
                <Database size={16} className="text-primary" />
                {t('setup.db_title')}
              </div>
              <p className="mb-4 text-xs text-muted-foreground">
                {t('setup.db_description')}
              </p>

              <div className="space-y-4">
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border bg-muted/40 p-4 text-sm">
                  <span className="text-muted-foreground">{t('settings.general_db_engine')}</span>
                  <span className="font-medium text-foreground">
                    {dbInfo ? (dbInfo.engine === 'sqlite' ? 'SQLite' : dbInfo.engine === 'postgresql' ? 'PostgreSQL' : dbInfo.engine) : '…'}
                  </span>
                  <span className="text-muted-foreground">{t('setup.db_location')}</span>
                  <span className="break-all font-mono text-xs text-foreground">
                    {dbInfo?.location ?? '…'}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground">
                  {t('setup.db_readonly_hint')}
                </p>

                <div className="flex items-center pt-2">
                  <Button size="sm" className="ml-auto" onClick={() => setStep(2)}>
                    {t('setup.next')}
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Admin account */}
        {step === 2 && (
          <Card>
            <CardContent className="p-6">
              <h3 className="mb-1 text-sm font-medium text-foreground">
                {t('setup.admin_title')}
              </h3>
              <p className="mb-4 text-xs text-muted-foreground">
                {t('setup.admin_description')}
              </p>

              <form onSubmit={handleCreateAdmin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="admin-username">{t('setup.admin_username')}</Label>
                  <Input
                    id="admin-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="admin-email">{t('setup.admin_email')}</Label>
                  <Input
                    id="admin-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="admin-password">{t('setup.admin_password')}</Label>
                  <PasswordInput
                    id="admin-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="admin-confirm">{t('setup.admin_password_confirm')}</Label>
                  <PasswordInput
                    id="admin-confirm"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                  {passwordMismatch && (
                    <p className="text-xs text-destructive">{t('setup.admin_password_mismatch')}</p>
                  )}
                </div>

                {createError && (
                  <p className="text-sm text-destructive">{createError}</p>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setStep(1)}>
                    <ChevronLeft size={14} />
                    {t('setup.back')}
                  </Button>

                  <Button
                    type="submit"
                    size="sm"
                    className="ml-auto"
                    disabled={creating || !username || !password || passwordMismatch}
                  >
                    {creating && <Loader2 size={14} className="animate-spin" />}
                    {creating ? t('setup.creating') : t('setup.create_account')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

/* Step indicator dot */
function StepDot({ active, completed, label }: { active: boolean; completed: boolean; label: string }) {
  return (
    <div
      className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : completed
            ? 'bg-green-600 text-white'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {completed ? <CheckCircle2 size={14} /> : label}
    </div>
  )
}
