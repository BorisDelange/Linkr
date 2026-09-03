import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { useSaveForm } from '@/hooks/use-save-form'
import { useHasGlobalPermission } from '@/stores/auth-store'
import { AppDatabaseDialog } from '@/features/settings/AppDatabaseDialog'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
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

const isServerMode = !!import.meta.env.VITE_API_URL

/**
 * Engines the application database may be switched to from here.
 *
 * PostgreSQL is deliberately not offered: only SQLite has been exercised, and
 * switching engines mid-life has no migration path — the existing data does not
 * follow, so picking Postgres on a live instance would silently start from an
 * empty database. The type below still admits it so an instance already
 * configured that way (via LINKR_DATABASE_URL) reads and renders correctly.
 */
const DB_ENGINES = ['sqlite'] as const
type DbEngine = 'sqlite' | 'postgresql'

interface DbConnectionConfig {
  engine: DbEngine
  // SQLite
  sqlitePath: string
  // PostgreSQL
  host: string
  port: string
  database: string
  username: string
  password: string
  ssl: boolean
}

const defaultConfig: DbConnectionConfig = {
  engine: 'sqlite',
  sqlitePath: './linkr.db',
  host: 'localhost',
  port: '5432',
  database: 'linkr',
  username: '',
  password: '',
  ssl: false,
}

const STORAGE_KEY = 'linkr-app-db-config'

function loadConfig(): DbConnectionConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaultConfig, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...defaultConfig }
}

function saveConfig(config: DbConnectionConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

/* ------------------------------------------------------------------ */
/*  Main GeneralTab                                                    */
/* ------------------------------------------------------------------ */

export function GeneralTab() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<DbConnectionConfig>(loadConfig)
  const [savedConfig, setSavedConfig] = useState<DbConnectionConfig>(loadConfig)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [queryOpen, setQueryOpen] = useState(false)
  const canQueryAppDb = useHasGlobalPermission('app-database:read')

  const updateField = <K extends keyof DbConnectionConfig>(key: K, value: DbConnectionConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setTestStatus('idle')
  }

  const handleSave = () => {
    saveConfig(config)
    setSavedConfig(config)  // becomes the new baseline → Save greys out again
  }

  const { canSaveNow, save } = useSaveForm({
    current: config,
    baseline: savedConfig,
    onSave: handleSave,
  })

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestMessage('')
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res = await fetch(`${baseUrl}/api/v1/health`)
      if (res.ok) {
        setTestStatus('success')
        setTestMessage(t('settings.general_db_test_success'))
      } else {
        setTestStatus('error')
        setTestMessage(t('settings.general_db_test_error_status', { status: res.status }))
      }
    } catch {
      setTestStatus('error')
      setTestMessage(t('settings.general_db_test_error_unreachable'))
    }
  }

  // The whole tab is the Application-database section — hide it entirely (title +
  // description included) for users without app-database:read.
  if (isServerMode && !canQueryAppDb) return null

  if (!isServerMode) {
    return <ServerModeNotice />
  }

  return (
    <div className="mt-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {t('settings.general_db_title')}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('settings.general_db_description')}
        </p>
      </div>

      <Card className="mt-4">
        <CardContent className="px-5 pb-5 pt-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Database size={16} className="text-primary" />
            {t('settings.general_db_connection')}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Engine selector */}
            <div className="space-y-2 sm:col-span-2">
              <Label>{t('settings.general_db_engine')}</Label>
              <Select
                value={config.engine}
                onValueChange={(v) => updateField('engine', v as DbEngine)}
              >
                <SelectTrigger className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* The engine in use is always listed, even when it is no longer
                      offered: a Select whose value is absent from its options
                      renders blank, which would read as "unset" on an instance
                      that is in fact running on Postgres. */}
                  {[...new Set<DbEngine>([...DB_ENGINES, config.engine])].map((engine) => (
                    <SelectItem key={engine} value={engine}>
                      {t(`settings.general_db_engine_${engine}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* SQLite fields */}
            {config.engine === 'sqlite' && (
              <div className="space-y-2 sm:col-span-2">
                <Label>{t('settings.general_db_sqlite_path')}</Label>
                <Input
                  value={config.sqlitePath}
                  onChange={(e) => updateField('sqlitePath', e.target.value)}
                  placeholder="./linkr.db"
                  className="sm:w-96"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.general_db_sqlite_hint')}
                </p>
              </div>
            )}

            {/* PostgreSQL fields */}
            {config.engine === 'postgresql' && (
              <>
                <div className="space-y-2">
                  <Label>{t('settings.general_db_host')}</Label>
                  <Input
                    value={config.host}
                    onChange={(e) => updateField('host', e.target.value)}
                    placeholder="localhost"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('settings.general_db_port')}</Label>
                  <Input
                    value={config.port}
                    onChange={(e) => updateField('port', e.target.value)}
                    placeholder="5432"
                    className="w-28"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('settings.general_db_name')}</Label>
                  <Input
                    value={config.database}
                    onChange={(e) => updateField('database', e.target.value)}
                    placeholder="linkr"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('settings.general_db_username')}</Label>
                  <Input
                    value={config.username}
                    onChange={(e) => updateField('username', e.target.value)}
                    placeholder="postgres"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>{t('settings.general_db_password')}</Label>
                  <Input
                    type="password"
                    value={config.password}
                    onChange={(e) => updateField('password', e.target.value)}
                    className="sm:w-64"
                  />
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="mt-6 flex items-center gap-3">
            <Button onClick={save} size="sm" disabled={!canSaveNow}>
              {t('common.save')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={testStatus === 'testing'}
            >
              {testStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
              {t('settings.general_db_test')}
            </Button>
            {canQueryAppDb && (
              <Button variant="outline" size="sm" onClick={() => setQueryOpen(true)}>
                <Database size={14} />
                {t('settings.general_db_query')}
              </Button>
            )}

            {/* Test result */}
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
          </div>
        </CardContent>
      </Card>

      {/* Query / browse the app database (admin, server mode) */}
      <AppDatabaseDialog open={queryOpen} onOpenChange={setQueryOpen} />
    </div>
  )
}
