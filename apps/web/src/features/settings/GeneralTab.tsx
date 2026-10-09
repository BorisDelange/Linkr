import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Loader2 } from 'lucide-react'
import { useHasGlobalPermission } from '@/stores/auth-store'
import { AppDatabaseDialog } from '@/features/settings/AppDatabaseDialog'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { CopyablePath } from '@/components/ui/parquet-files-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { fetchAppDatabaseInfo, type AppDatabaseInfo } from '@/lib/api/database'

const isServerMode = !!import.meta.env.VITE_API_URL

/**
 * Read-only view of the application database. It is chosen at server start
 * (LINKR_DATA_DIR / LINKR_DATABASE_URL), never from the UI: switching engines
 * mid-life has no migration path.
 */
export function GeneralTab() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<AppDatabaseInfo | null>(null)
  const [error, setError] = useState(false)
  const [queryOpen, setQueryOpen] = useState(false)
  const canQueryAppDb = useHasGlobalPermission('app-database:read')

  useEffect(() => {
    if (!isServerMode || !canQueryAppDb) return
    fetchAppDatabaseInfo().then(setInfo, () => setError(true))
  }, [canQueryAppDb])

  if (!isServerMode) return <ServerModeNotice />
  // The whole tab is the Application-database section — hidden entirely for
  // users without app-database:read.
  if (!canQueryAppDb) return null

  const engineLabel = info
    ? t(`settings.general_db_engine_${info.engine}`, { defaultValue: info.engine })
    : ''

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

          {error ? (
            <p className="mt-4 text-xs text-destructive">{t('settings.general_db_info_error')}</p>
          ) : !info ? (
            <Loader2 size={14} className="mt-4 animate-spin text-muted-foreground" />
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <div className="space-y-1">
                <Label>{t('settings.general_db_engine')}</Label>
                <p className="text-sm text-foreground">{engineLabel}</p>
              </div>
              <div className="min-w-0 space-y-1">
                <Label>
                  {info.engine === 'sqlite'
                    ? t('settings.general_db_sqlite_path')
                    : t('settings.general_db_location')}
                </Label>
                <CopyablePath value={info.location} />
              </div>
            </div>
          )}

          <p className="mt-4 text-xs text-muted-foreground">{t('settings.general_db_config_hint')}</p>

          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={() => setQueryOpen(true)}>
              <Database size={14} />
              {t('settings.general_db_query')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AppDatabaseDialog open={queryOpen} onOpenChange={setQueryOpen} />
    </div>
  )
}
