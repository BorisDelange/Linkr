import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, CheckCircle2, XCircle, Loader2, FolderOpen, ChevronRight, Folder, File, ArrowLeft, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const isServerMode = !!import.meta.env.VITE_API_URL

const DB_ENGINES = ['sqlite', 'postgresql'] as const
type DbEngine = (typeof DB_ENGINES)[number]

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
/*  File browser types & component                                     */
/* ------------------------------------------------------------------ */

interface FsEntry {
  name: string
  type: 'directory' | 'file'
}

function FileBrowserDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
}) {
  const { t } = useTranslation()
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  const fetchEntries = async (dirPath: string) => {
    setLoading(true)
    setError('')
    setSelectedFile(null)
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res = await fetch(`${baseUrl}/api/v1/filesystem/browse?path=${encodeURIComponent(dirPath)}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const data: FsEntry[] = await res.json()
      setEntries(data)
      setCurrentPath(dirPath)
    } catch {
      setError(t('settings.general_db_browse_error'))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }

  const handleOpen = () => {
    if (open) fetchEntries(currentPath)
  }

  // Fetch on open
  useState(() => { if (open) fetchEntries(currentPath) })

  const navigateUp = () => {
    const parent = currentPath === '/' ? '/' : currentPath.replace(/\/[^/]+\/?$/, '') || '/'
    fetchEntries(parent)
  }

  const navigateTo = (entry: FsEntry) => {
    if (entry.type === 'directory') {
      const next = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`
      fetchEntries(next)
    } else {
      const full = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`
      setSelectedFile(full)
    }
  }

  const handleConfirm = () => {
    if (selectedFile) {
      onSelect(selectedFile)
      onOpenChange(false)
    }
  }

  // Also allow selecting the current directory (for "create new db here")
  const handleSelectFolder = () => {
    onSelect(currentPath === '/' ? '/linkr.db' : `${currentPath}/linkr.db`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (v) handleOpen() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.general_db_browse_title')}</DialogTitle>
        </DialogHeader>

        {/* Current path breadcrumb */}
        <div className="flex items-center gap-1 rounded-md bg-muted px-3 py-1.5 text-xs font-mono text-muted-foreground">
          <span className="truncate">{currentPath}</span>
        </div>

        {/* File list */}
        <div className="h-64 overflow-auto rounded-md border">
          {/* Go up */}
          {currentPath !== '/' && (
            <button
              className="flex w-full items-center gap-2 border-b px-3 py-2 text-sm hover:bg-muted/50"
              onClick={navigateUp}
            >
              <ArrowLeft size={14} className="text-muted-foreground" />
              <span className="text-muted-foreground">..</span>
            </button>
          )}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {t('settings.general_db_browse_empty')}
            </div>
          )}

          {!loading && entries.map((entry) => (
            <button
              key={entry.name}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 ${
                entry.type === 'file' && selectedFile?.endsWith(`/${entry.name}`)
                  ? 'bg-primary/10'
                  : ''
              }`}
              onClick={() => navigateTo(entry)}
            >
              {entry.type === 'directory' ? (
                <>
                  <Folder size={14} className="shrink-0 text-primary" />
                  <span className="truncate">{entry.name}</span>
                  <ChevronRight size={12} className="ml-auto shrink-0 text-muted-foreground" />
                </>
              ) : (
                <>
                  <File size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </>
              )}
            </button>
          ))}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={handleSelectFolder}>
            {t('settings.general_db_browse_use_folder')}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={!selectedFile}>
            {t('settings.general_db_browse_select')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/*  Main GeneralTab                                                    */
/* ------------------------------------------------------------------ */

export function GeneralTab() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<DbConnectionConfig>(loadConfig)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [saved, setSaved] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)

  const updateField = <K extends keyof DbConnectionConfig>(key: K, value: DbConnectionConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
    setTestStatus('idle')
  }

  const handleSave = () => {
    saveConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

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

  if (!isServerMode) {
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

        <div className="flex flex-col items-center py-12">
          <Database size={36} className="text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium text-foreground">
            {t('settings.general_db_requires_backend')}
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950 max-w-md">
            <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('settings.general_db_requires_backend_description')}
            </p>
          </div>
        </div>
      </div>
    )
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
        <CardContent className="p-5">
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
                  {DB_ENGINES.map((engine) => (
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
                <div className="flex gap-2">
                  <Input
                    value={config.sqlitePath}
                    onChange={(e) => updateField('sqlitePath', e.target.value)}
                    placeholder="./linkr.db"
                    className="sm:w-96"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setBrowseOpen(true)}
                    title={t('settings.general_db_browse')}
                  >
                    <FolderOpen size={16} />
                  </Button>
                </div>
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
            <Button onClick={handleSave} size="sm">
              {saved ? t('settings.general_db_saved') : t('common.save')}
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

      {/* File browser dialog */}
      <FileBrowserDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        onSelect={(path) => updateField('sqlitePath', path)}
      />
    </div>
  )
}
