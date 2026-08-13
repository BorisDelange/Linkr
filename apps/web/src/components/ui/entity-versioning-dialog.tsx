import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { VersioningTabs, type VersioningTab } from '@/components/versioning/VersioningTabs'
import type { GitScope } from '@/lib/api/git'
import type { GitRemoteConfig } from '@/types'

interface EntityVersioningDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which tab to show first. */
  initialTab?: VersioningTab
  /** Whether the export supports an "include data" toggle (false hides it). Ignored when exportContent is given. */
  supportsIncludeData?: boolean
  /** Run the per-entity export. Required unless a custom exportContent is provided. */
  onExport?: (options: { includeDataFiles: boolean }) => void | Promise<void>
  /** Custom export UI (e.g. the full workspace export). Overrides the default entity export tab. */
  exportContent?: React.ReactNode
  /** Current git link of the entity, or null when unlinked. */
  gitRemote: GitRemoteConfig | null
  /** Persist a git link (or null to unlink) on the entity. */
  onSaveGitRemote: (config: GitRemoteConfig | null) => void | Promise<void>
  /** Show only the Git tab (for entities whose export lives on a dedicated page). */
  gitOnly?: boolean
  /** Scope + id enable the push-only sync panel in the Git tab (server mode). */
  syncScope?: GitScope
  syncId?: string
  /** Custom pull UI, forwarded to the sync panel. Supplying it is also what turns
   *  ON behind/diverged detection for the scope (see GitSyncPanel). */
  renderPullDialog?: React.ComponentProps<typeof VersioningTabs>['renderPullDialog']
  renderInlinePull?: React.ComponentProps<typeof VersioningTabs>['renderInlinePull']
  onAfterPull?: React.ComponentProps<typeof VersioningTabs>['onAfterPull']
}

/** Export tab body for a single entity: include-data option + download (or git-linked hint). */
function EntityExportContent({
  supportsIncludeData,
  isLinked,
  onExport,
  onDone,
}: {
  supportsIncludeData: boolean
  isLinked: boolean
  onExport: (options: { includeDataFiles: boolean }) => void | Promise<void>
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [includeData, setIncludeData] = useState(false)

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="space-y-3">
        {isLinked ? (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('app_versioning.entity_export_git_linked_hint')}
          </p>
        ) : supportsIncludeData ? (
          <>
            <div className="flex items-center gap-2">
              <Checkbox id="entity-export-include-data" checked={includeData} onCheckedChange={(v) => setIncludeData(v === true)} />
              <Label htmlFor="entity-export-include-data" className="text-sm font-normal cursor-pointer">
                {t('versioning.export_include_data')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">{t('versioning.export_include_data_hint')}</p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('versioning.export_description')}</p>
        )}
      </div>
      <div className="mt-6 flex justify-end">
        <Button onClick={async () => { await onExport({ includeDataFiles: includeData }); onDone() }} className="gap-1.5">
          <Download size={14} />
          {t('versioning.export_download')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Per-entity versioning dialog. Renders the shared VersioningTabs (Git · Export)
 * inside a dialog, so it stays consistent with the workspace/project versioning pages.
 */
export function EntityVersioningDialog({
  open,
  onOpenChange,
  initialTab = 'git',
  supportsIncludeData = true,
  onExport,
  exportContent,
  gitRemote,
  onSaveGitRemote,
  gitOnly = false,
  syncScope,
  syncId,
  renderPullDialog,
  renderInlinePull,
  onAfterPull,
}: EntityVersioningDialogProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<VersioningTab>(gitOnly ? 'git' : initialTab)

  // Size the dialog to the active tab so Export stays compact and Git grows to
  // fit the sync panel (file list + diff + commit). The Git tab needs the room
  // only when a sync scope is present; a custom export (e.g. the full workspace
  // export) is roomy on its own tab regardless.
  const gitNeedsRoom = tab === 'git' && !!syncScope
  const exportNeedsRoom = tab === 'export' && !!exportContent
  const wide = gitNeedsRoom || exportNeedsRoom

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wide ? 'flex h-[85vh] max-h-[85vh] flex-col sm:max-w-3xl' : undefined}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('app_versioning.entity_versioning_title')}</DialogTitle>
          <DialogDescription>{t('app_versioning.entity_versioning_description')}</DialogDescription>
        </DialogHeader>

        <VersioningTabs
          initialTab={initialTab}
          tab={tab}
          onTabChange={setTab}
          fillHeight={wide}
          gitOnly={gitOnly}
          syncScope={syncScope}
          syncId={syncId}
          renderPullDialog={renderPullDialog}
          renderInlinePull={renderInlinePull}
          onAfterPull={onAfterPull}
          gitRemote={gitRemote}
          onSaveGitRemote={onSaveGitRemote}
          exportContent={
            exportContent ?? (
              <EntityExportContent
                supportsIncludeData={supportsIncludeData}
                isLinked={!!gitRemote?.url}
                onExport={onExport ?? (() => {})}
                onDone={() => onOpenChange(false)}
              />
            )
          }
        />
      </DialogContent>
    </Dialog>
  )
}
