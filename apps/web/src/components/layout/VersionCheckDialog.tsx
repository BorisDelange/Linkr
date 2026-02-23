import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { checkVersion, acknowledgeVersion, type VersionStatus } from '@/lib/version-check'

export function VersionCheckDialog() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<VersionStatus | null>(null)

  useEffect(() => {
    const result = checkVersion()
    if (result.kind === 'first-visit') {
      // First visit — silently store version, no dialog
      acknowledgeVersion()
    } else if (result.kind === 'new-build') {
      setStatus(result)
    }
    // 'up-to-date' → no dialog
  }, [])

  if (!status || status.kind !== 'new-build') return null

  const handleReload = () => {
    acknowledgeVersion()
    window.location.reload()
  }

  const handleResetData = async () => {
    const databases = await indexedDB.databases()
    for (const db of databases) {
      if (db.name) indexedDB.deleteDatabase(db.name)
    }
    localStorage.clear()
    window.location.href = '/'
  }

  const handleDismiss = () => {
    acknowledgeVersion()
    setStatus(null)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleDismiss() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('version_check.title')}</DialogTitle>
          <DialogDescription asChild>
            <div className="mt-3 space-y-3">
              <p>{t('version_check.description')}</p>
              {status.schemaChanged && (
                <p className="font-medium text-destructive">
                  {t('version_check.schema_warning')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('version_check.dev_notice')}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={handleDismiss}>
              <X size={14} />
              {t('version_check.dismiss')}
            </Button>
            {status.schemaChanged && (
              <Button variant="destructive" onClick={handleResetData}>
                <Trash2 size={14} />
                {t('version_check.reset_data')}
              </Button>
            )}
            <Button onClick={handleReload}>
              <RefreshCw size={14} />
              {t('version_check.reload')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
