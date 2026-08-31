import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { useAppStore } from '@/stores/app-store'
import { isServerMode } from '@/lib/api-client'
import { checkVersion, acknowledgeVersion, clearAllData } from '@/lib/version-check'
import {
  detectSeedChanges, storeSeedHashes, fetchSeedHashes, getStoredSeedHashes,
  type SeedChange, type SeedDiffResult,
} from '@/lib/seed-change-detector'
import { reseedSelection, deleteRemovedSelection, removedDisposition, isWorkspaceKept } from '@/lib/targeted-reseed'
import { refreshStoresAfterReseed } from '@/lib/seed-store-refresh'
import { SeedUpdateDialog } from './SeedUpdateDialog'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VersionCheckDialog() {
  const { t } = useTranslation()
  const dismissSeedUpdates = useAppStore((s) => s.dismissSeedUpdateNotifications)
  const [schemaChanged, setSchemaChanged] = useState(false)
  const [seedDiff, setSeedDiff] = useState<SeedDiffResult | null>(null)

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
      setSchemaChanged(true)
      return
    }

    // Otherwise (up-to-date OR a non-breaking new build): nothing to tell the user
    // about the app itself — a reload already served them the new build. Record the
    // hash right away so the next check compares against this build.
    acknowledgeVersion()

    // Server mode owns no bundled seed: its default data is a catalog install, and
    // updating it is the catalog's own update flow. Diffing `public/data/seed/`
    // here would offer one browser the chance to rewrite content shared by every
    // user of the instance. The schema dialog above still applies.
    if (isServerMode()) return

    // The seed content can change even when the app build is identical — portal
    // deployments update the bundled workspaces/projects far more often than the app
    // itself — so diff it independently of the build hash.
    detectSeedChanges().then((diff) => {
      setSeedDiff(diff)

      if (diff.hasChanges && dismissSeedUpdates) {
        // User opted out of seed notifications — silently advance the baseline.
        fetchSeedHashes().then((h) => { if (h) storeSeedHashes(h) })
      }
    })
  }, [dismissSeedUpdates])

  // --- Schema changed: blocking dialog ---
  if (schemaChanged) {
    const handleResetData = () => clearAllData()

    const handleDismiss = () => {
      acknowledgeVersion()
      setSchemaChanged(false)
    }

    return (
      <DialogShell
        open
        onOpenChange={(open) => { if (!open) handleDismiss() }}
        title={t('version_check.schema_title')}
        description={t('version_check.schema_description')}
        onConfirm={handleResetData}
        confirmLabel={
          <>
            <Trash2 size={14} />
            {t('version_check.reset_data')}
          </>
        }
        destructive
        cancelLabel={t('version_check.dismiss')}
        contentClassName="space-y-0"
      >
        <p className="text-xs text-muted-foreground">{t('version_check.schema_hint')}</p>
      </DialogShell>
    )
  }

  // --- Seed data changed: selection dialog (re-import a chosen subset) ---
  // Shown whenever the bundled content differs from the local baseline, even if the
  // app build is unchanged.
  if (seedDiff?.hasChanges && !dismissSeedUpdates) {
    const handleKeepData = async () => {
      acknowledgeVersion()
      // "Keep my data" is a deliberate choice: advance the whole baseline so this stops showing.
      const hashes = await fetchSeedHashes()
      if (hashes) storeSeedHashes(hashes)
      setSeedDiff(null)
    }

    // Closing without choosing (click-outside / Esc / X) is NOT a decision: dismiss for this
    // session only, leaving the baseline untouched so the dialog reappears on the next reload.
    const handleDismiss = () => setSeedDiff(null)

    const handleApply = async (reseed: SeedChange[], remove: SeedChange[]) => {
      // Delete BEFORE re-seeding. On a replacement both workspaces occupy the same seed folder
      // and ship projects under the same slugs; a project is resolved by slug, so re-seeding
      // first made the removal pass find the rows just created and delete them as if they were
      // the outgoing ones — the new workspace arrived with no projects.
      const deleted = await deleteRemovedSelection(remove)
      const reseeded = await reseedSelection(reseed)
      setSeedDiff(null)
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
        workspaceKept={async (c) => isWorkspaceKept(c, seedDiff.changes.filter((x) => x.changeType === 'removed'))}
      />
    )
  }

  // A plain new build needs no notice: the reload already served it.
  return null
}
