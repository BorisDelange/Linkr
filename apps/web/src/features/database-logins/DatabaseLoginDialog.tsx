import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { formatApiError } from '@/lib/api-client'
import { saveMyDatabaseLogin } from '@/lib/api/database-logins'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DatabaseConnectionConfig } from '@/types'

interface DatabaseLoginDialogProps {
  dataSourceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  /** The database accepts session-only logins alone: no "remember" choice. */
  sessionOnly?: boolean
  /** Pre-fill when changing an existing login. */
  initialUsername?: string
}

/** The user's own account for one external database: tested against the
 *  database before it is kept, and never shown again. Mount it with a `key`
 *  per opening — its fields start from the props. */
export function DatabaseLoginDialog({
  dataSourceId, open, onOpenChange, onSaved, sessionOnly = false, initialUsername = '',
}: DatabaseLoginDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const source = useDataSourceStore((s) => s.dataSources.find((d) => d.id === dataSourceId))
  const [username, setUsername] = useState(initialUsername)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(!sessionOnly)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const errorText = useCallback((err: unknown) => {
    const f = formatApiError(err)
    return f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err))
  }, [t])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveMyDatabaseLogin(dataSourceId, username.trim(), password, remember && !sessionOnly)
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const config = source?.connectionConfig as DatabaseConnectionConfig | undefined
  const where = config?.host ? `${config.host}${config.port ? `:${config.port}` : ''}${config.database ? ` / ${config.database}` : ''}` : null
  const name = source ? localized(source.name, language) : dataSourceId

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('database_logins.dialog_title', { name })}
      description={t('database_logins.dialog_description')}
      onConfirm={handleSave}
      confirmLabel={t('database_logins.test_and_save')}
      confirmDisabled={!username.trim() || !password}
      busy={saving}
    >
      {where && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <KeyRound size={14} className="shrink-0" />
          <span className="truncate font-mono">{where}</span>
        </div>
      )}
      <FormField label={t('database_logins.username')} required>
        {({ id }) => (
          <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        )}
      </FormField>
      <FormField label={t('database_logins.password')} required>
        {({ id }) => (
          <PasswordInput id={id} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        )}
      </FormField>
      <div className="flex items-start gap-2">
        <Switch id="db-login-remember" checked={remember && !sessionOnly} disabled={sessionOnly} onCheckedChange={setRemember} />
        <div className="space-y-0.5">
          <Label htmlFor="db-login-remember">{t('database_logins.remember')}</Label>
          <p className="text-xs text-muted-foreground">
            {sessionOnly ? t('database_logins.remember_forbidden') : t('database_logins.remember_hint')}
          </p>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </DialogShell>
  )
}
