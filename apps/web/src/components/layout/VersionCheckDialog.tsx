import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Trash2, X, Info, Database, FileText, GitBranch,
  Layout, FolderKanban, Map, ShieldCheck, BookOpen,
  Plus, Pencil, Minus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  type SeedChange, type SeedDiffResult, type SeedEntityType, type SeedChangeType,
} from '@/lib/seed-change-detector'

// ---------------------------------------------------------------------------
// Entity type → icon mapping
// ---------------------------------------------------------------------------

const entityIcons: Record<SeedEntityType, typeof Database> = {
  workspace: FolderKanban,
  database: Database,
  conceptMapping: Map,
  etlScript: GitBranch,
  dataset: FileText,
  dashboard: Layout,
  project: FolderKanban,
  mappingProject: Map,
  dqRuleSet: ShieldCheck,
  catalog: BookOpen,
}

const changeIcons: Record<SeedChangeType, typeof Plus> = {
  added: Plus,
  modified: Pencil,
  removed: Minus,
}

const changeBadgeVariant: Record<SeedChangeType, 'default' | 'secondary' | 'destructive'> = {
  added: 'default',
  modified: 'secondary',
  removed: 'destructive',
}

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
    if (result.kind === 'first-visit' || result.kind === 'up-to-date') {
      if (result.kind === 'first-visit') acknowledgeVersion()
      // Store seed hashes if not yet present (first visit or migration from pre-feature build)
      if (!getStoredSeedHashes()) {
        fetchSeedHashes().then((h) => { if (h) storeSeedHashes(h) })
      }
    } else if (result.kind === 'new-build') {
      setStatus(result)

      // For non-schema-breaking updates, check seed changes
      if (!result.schemaChanged) {
        setSeedChecking(true)
        detectSeedChanges().then((diff) => {
          setSeedDiff(diff)
          setSeedChecking(false)

          if (!diff.hasChanges || dismissSeedUpdates) {
            // No changes, or user opted out — silently acknowledge
            acknowledgeVersion()
            if (diff.hasChanges) {
              // Still store new hashes so we don't re-detect same changes
              fetchSeedHashes().then((h) => { if (h) storeSeedHashes(h) })
            }
          }
        })
      }
    }
  }, [dismissSeedUpdates])

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

  // --- Seed data changed: blocking dialog with change list ---
  if (seedDiff?.hasChanges && !dismissSeedUpdates) {
    const handleResetData = () => clearAllData()

    const handleKeepData = async () => {
      acknowledgeVersion()
      // Store the new hashes so we don't show this again
      const hashes = await fetchSeedHashes()
      if (hashes) storeSeedHashes(hashes)
      setStatus(null)
    }

    // Group changes by workspace
    const byWorkspace = new globalThis.Map<string, SeedChange[]>()
    for (const change of seedDiff.changes) {
      const key = change.workspaceFolder
      if (!byWorkspace.has(key)) byWorkspace.set(key, [])
      byWorkspace.get(key)!.push(change)
    }

    return (
      <Dialog open onOpenChange={(open) => { if (!open) handleKeepData() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('version_check.seed_changed_title')}</DialogTitle>
            <DialogDescription asChild>
              <div className="mt-3 space-y-3">
                <p>{t('version_check.seed_changed_description')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[300px] rounded-md border p-3">
            <div className="space-y-4">
              {[...byWorkspace.entries()].map(([wsFolder, changes]) => (
                <div key={wsFolder}>
                  <p className="text-sm font-medium mb-2">{wsFolder}</p>
                  <div className="space-y-1.5">
                    {changes.map((change) => {
                      const EntityIcon = entityIcons[change.entityType]
                      const ChangeIcon = changeIcons[change.changeType]
                      return (
                        <div
                          key={`${change.entityType}-${change.entityId}`}
                          className="flex items-center gap-2 text-xs"
                        >
                          <EntityIcon size={13} className="shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">
                            {t(`version_check.seed_entity_${change.entityType}`)}
                          </span>
                          <span className="truncate font-medium">{change.entityLabel}</span>
                          <Badge
                            variant={changeBadgeVariant[change.changeType]}
                            className="ml-auto shrink-0 text-[10px] px-1.5 py-0"
                          >
                            <ChangeIcon size={10} className="mr-0.5" />
                            {t(`version_check.seed_change_${change.changeType}`)}
                          </Badge>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={handleKeepData}>
              {t('version_check.keep_data')}
            </Button>
            <Button variant="destructive" onClick={handleResetData}>
              <Trash2 size={14} />
              {t('version_check.reset_data')}
            </Button>
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
