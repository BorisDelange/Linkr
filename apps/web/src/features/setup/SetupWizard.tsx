import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Database,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LinkrLogo } from '@/components/ui/linkr-logo'
import { getApiBaseUrl } from '@/lib/api-client'

const DB_ENGINES = ['sqlite', 'postgresql'] as const
type DbEngine = (typeof DB_ENGINES)[number]

interface SetupWizardProps {
  onComplete: () => void
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState(1)

  // Step 1: DB config (informational for now)
  const [engine, setEngine] = useState<DbEngine>('sqlite')
  const [sqlitePath, setSqlitePath] = useState('./linkr.db')
  const [pgHost, setPgHost] = useState('localhost')
  const [pgPort, setPgPort] = useState('5432')
  const [pgDatabase, setPgDatabase] = useState('linkr')
  const [pgUsername, setPgUsername] = useState('')
  const [pgPassword, setPgPassword] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')

  // Step 2: Admin account
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestMessage('')
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/health`)
      if (res.ok) {
        setTestStatus('success')
        setTestMessage(t('setup.test_success'))
      } else {
        setTestStatus('error')
        setTestMessage(t('setup.test_error'))
      }
    } catch {
      setTestStatus('error')
      setTestMessage(t('setup.test_unreachable'))
    }
  }

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
                {/* Engine selector */}
                <div className="space-y-2">
                  <Label>{t('settings.general_db_engine')}</Label>
                  <Select value={engine} onValueChange={(v) => setEngine(v as DbEngine)}>
                    <SelectTrigger className="w-full sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DB_ENGINES.map((e) => (
                        <SelectItem key={e} value={e}>
                          {t(`settings.general_db_engine_${e}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* SQLite */}
                {engine === 'sqlite' && (
                  <div className="space-y-2">
                    <Label>{t('settings.general_db_sqlite_path')}</Label>
                    <Input
                      value={sqlitePath}
                      onChange={(e) => setSqlitePath(e.target.value)}
                      placeholder="./linkr.db"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('settings.general_db_sqlite_hint')}
                    </p>
                  </div>
                )}

                {/* PostgreSQL */}
                {engine === 'postgresql' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{t('settings.general_db_host')}</Label>
                      <Input value={pgHost} onChange={(e) => setPgHost(e.target.value)} placeholder="localhost" />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('settings.general_db_port')}</Label>
                      <Input value={pgPort} onChange={(e) => setPgPort(e.target.value)} placeholder="5432" className="w-28" />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('settings.general_db_name')}</Label>
                      <Input value={pgDatabase} onChange={(e) => setPgDatabase(e.target.value)} placeholder="linkr" />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('settings.general_db_username')}</Label>
                      <Input value={pgUsername} onChange={(e) => setPgUsername(e.target.value)} placeholder="postgres" />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label>{t('settings.general_db_password')}</Label>
                      <Input type="password" value={pgPassword} onChange={(e) => setPgPassword(e.target.value)} className="sm:w-64" />
                    </div>
                  </div>
                )}

                {/* Test + Next */}
                <div className="flex items-center gap-3 pt-2">
                  <Button variant="outline" size="sm" onClick={handleTestConnection} disabled={testStatus === 'testing'}>
                    {testStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
                    {t('settings.general_db_test')}
                  </Button>

                  {testStatus === 'success' && (
                    <span className="flex items-center gap-1 text-xs text-green-600">
                      <CheckCircle2 size={14} />
                      {testMessage}
                    </span>
                  )}
                  {testStatus === 'error' && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XCircle size={14} />
                      {testMessage}
                    </span>
                  )}

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
                  <Input
                    id="admin-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="admin-confirm">{t('setup.admin_password_confirm')}</Label>
                  <Input
                    id="admin-confirm"
                    type="password"
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
            ? 'bg-primary/20 text-primary'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {completed ? <CheckCircle2 size={14} /> : label}
    </div>
  )
}
