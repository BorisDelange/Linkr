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
import { useAppStore } from '@/stores/app-store'
import { checkVersion, acknowledgeVersion, clearAllData, type VersionStatus } from '@/lib/version-check'
import {
  detectSeedChanges, storeSeedHashes, fetchSeedHashes, getStoredSeedHashes,
  type SeedChange, type SeedDiffResult,
} from '@/lib/seed-change-detector'
import { reseedSelection, deleteRemovedSelection, removedDisposition } from '@/lib/targeted-reseed'
import { refreshStoresAfterReseed } from '@/lib/seed-store-refresh'
import { SeedUpdateDialog } from './SeedUpdateDialog'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VersionCheckDialog() {
  const { t } = useTranslation()
  const dismissSeedUpdates = useAppStore((s) => s.dismissSeedUpdateNotifications)
  const [status, setStatus] = useState<VersionStatus | null>(null)
  const [seedDiff, setSeedDiff] = useState<SeedDiffResult | null>(null)
  const [seedChecking, setSeedChecking] = useState(false)

  useEffect(() => {
    const result = checkVersion()

    if (result.kind === 'first-visit') {
      acknowledgeVersion()
      // Record the baseline seed hashes so future content changes are detectable.
      if (!getStoredSeedHashes()) {
        fetchSeedHashes().then((h) => { if (h) storeSeedHashes(h) })
      }
      return
    }

    // A schema-breaking app update needs its own blocking dialog; skip seed diffing.
    if (result.kind === 'new-build' && result.schemaChanged) {
      setStatus(result)
      return
    }

    // Otherwise (up-to-date OR a non-breaking new build): the seed content can have
    // changed even when the app build is identical — portal deployments update the
    // bundled workspaces/projects far more often than the app itself. So always diff
    // the seed against the stored baseline, independent of the build hash.
    if (result.kind === 'new-build') setStatus(result)
    setSeedChecking(true)
    detectSeedChanges().then((diff) => {
      setSeedDiff(diff)
      setSeedChecking(false)

      if (!diff.hasChanges || dismissSeedUpdates) {
        // No changes, or user opted out — acknowledge and silently advance the baseline.
        acknowledgeVersion()
        if (diff.hasChanges) {
          fetchSeedHashes().then((h) => { if (h) storeSeedHashes(h) })
        }
      }
    })
  }, [dismissSeedUpdates])

  // --- Seed data changed: selection dialog (re-import a chosen subset) ---
  // Shown whenever the bundled content differs from the local baseline, even if the
  // app build is unchanged. Checked before the build-status guard below.
  if (seedDiff?.hasChanges && !dismissSeedUpdates) {
    const handleKeepData = async () => {
      acknowledgeVersion()
      // "Keep my data" is a deliberate choice: advance the whole baseline so this stops showing.
      const hashes = await fetchSeedHashes()
      if (hashes) storeSeedHashes(hashes)
      setSeedDiff(null)
      setStatus(null)
    }

    // Closing without choosing (click-outside / Esc / X) is NOT a decision: dismiss for this
    // session only, leaving the baseline untouched so the dialog reappears on the next reload.
    const handleDismiss = () => {
      setSeedDiff(null)
      setStatus(null)
    }

    const handleApply = async (reseed: SeedChange[], remove: SeedChange[]) => {
      const reseeded = await reseedSelection(reseed)
      const deleted = await deleteRemovedSelection(remove)
      acknowledgeVersion()
      setSeedDiff(null)
      setStatus(null)
      // Refresh just the affected stores from IndexedDB; fall back to a full reload only
      // if a touched type has no clean in-memory refresh path.
      const refreshed = await refreshStoresAfterReseed([...reseeded, ...deleted])
      if (!refreshed) window.location.reload()
    }

    return (
      <SeedUpdateDialog
        diff={seedDiff}
        onApply={handleApply}
        onKeep={handleKeepData}
        onDismiss={handleDismiss}
        canDeleteRemoved={async (c) => (await removedDisposition(c)) !== 'user'}
      />
    )
  }

  if (!status || status.kind !== 'new-build') return null

  // --- Schema changed: blocking dialog (unchanged) ---
  if (status.schemaChanged) {
    const handleResetData = () => clearAllData()

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

  // Still checking seed changes — don't show anything yet
  if (seedChecking) return null

  // --- No seed changes: non-blocking info banner ---
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
