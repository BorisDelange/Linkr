import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, X, Info } from 'lucide-react'
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
      acknowledgeVersion()
    } else if (result.kind === 'new-build') {
      setStatus(result)
      // Non-breaking update: auto-acknowledge after showing the banner
      if (!result.schemaChanged) acknowledgeVersion()
    }
  }, [])

  if (!status || status.kind !== 'new-build') return null

  // --- Schema changed: blocking dialog ---
  if (status.schemaChanged) {
    const handleResetData = async () => {
      try {
        const databases = await indexedDB.databases()
        for (const db of databases) {
          if (db.name) indexedDB.deleteDatabase(db.name)
        }
      } catch { /* best effort */ }
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
            <DialogTitle>{t('version_check.schema_title')}</DialogTitle>
            <DialogDescription asChild>
              <div className="mt-3 space-y-3">
                <p>{t('version_check.schema_description')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('version_check.schema_hint')}
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={handleDismiss}>
                {t('version_check.dismiss')}
              </Button>
              <Button variant="destructive" onClick={handleResetData}>
                <Trash2 size={14} />
                {t('version_check.reset_data')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // --- Schema unchanged: non-blocking info banner ---
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-start gap-3 rounded-lg border bg-background p-4 shadow-lg">
        <Info size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 space-y-1">
          <p className="text-sm font-medium">{t('version_check.update_title')}</p>
          <p className="text-xs text-muted-foreground">{t('version_check.update_description')}</p>
        </div>
        <button
          onClick={() => setStatus(null)}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
