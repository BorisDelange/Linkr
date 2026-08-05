import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { GitErrorInline } from '@/components/versioning/GitErrorInline'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { commitCatalogInstall, prepareCatalogInstall, type PreparedInstall } from '@/lib/catalog/install'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { InstalledInfo } from '@/lib/catalog/installed'
import type { CatalogEntry } from '@/lib/catalog/types'

interface CatalogInstallDialogProps {
  entry: CatalogEntry | null
  /** Target workspace, chosen in the page toolbar. */
  workspaceId: string
  /** Set when the entry already exists in that workspace — drives the update wording. */
  installed?: InstalledInfo
  onOpenChange: (open: boolean) => void
  onInstalled?: (entry: CatalogEntry, id: string) => void
}

/**
 * Confirms, then clones the entry's repo into the workspace selected on the page.
 *
 * Two shapes, one flow. A fresh entry gets a plain confirm; an already-installed one is
 * an *update*, and is stated as such (which version replaces which) — but both end in
 * the same duplicate-or-overwrite prompt, because the collision is decided by the id the
 * repo declares, which is only knowable after the clone.
 *
 * The clone itself goes through the shared git-linked-entity path
 * (`prepareCatalogInstall`/`commitCatalogInstall`), not a second import implementation.
 */
export function CatalogInstallDialog({
  entry,
  workspaceId,
  installed,
  onOpenChange,
  onInstalled,
}: CatalogInstallDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)

  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Cloned repo awaiting a duplicate-or-overwrite answer. */
  const [conflict, setConflict] = useState<PreparedInstall | null>(null)

  const serverMode = isServerMode()
  const isUpdate = !!installed
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? ''

  useEffect(() => { if (entry) setError(null) }, [entry])

  /** Write a prepared clone; shared by the no-conflict path and both conflict answers. */
  const commit = async (prepared: PreparedInstall, duplicate: boolean) => {
    setInstalling(true)
    try {
      const result = await commitCatalogInstall(prepared, workspaceId, language, duplicate)
      if (!result.ok) {
        setError(result.error ?? t('catalog.install_failed'))
        return
      }
      // Freshly cloned rows land straight in storage; refresh the workspace list so
      // counts and the target workspace's contents reflect the install.
      await loadWorkspaces()
      onInstalled?.(prepared.entry, result.id!)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const handleInstall = async () => {
    if (!entry || !workspaceId || installing) return
    setError(null)
    setInstalling(true)
    try {
      // Clone first, then check for a collision: the id that decides it is declared by
      // the repo, so it isn't knowable before the clone.
      const prep = await prepareCatalogInstall(entry)
      if (!prep.ok) {
        setError(prep.error ?? t('catalog.install_failed'))
        return
      }
      if (prep.prepared.existingName) {
        setConflict(prep.prepared)
        return
      }
      await commit(prep.prepared, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.existingName ?? ''}
      onDuplicate={() => { const p = conflict; setConflict(null); if (p) void commit(p, true) }}
      onOverwrite={() => { const p = conflict; setConflict(null); if (p) void commit(p, false) }}
    />
    <Dialog open={!!entry} onOpenChange={(o) => { if (!installing && !o) onOpenChange(false) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isUpdate ? t('catalog.update_title') : t('catalog.install_title')}</DialogTitle>
          <DialogDescription>
            {entry ? localized(entry.name, language) : ''}
          </DialogDescription>
        </DialogHeader>

        {!serverMode ? (
          <ServerModeNotice inline description={t('catalog.install_requires_server')} />
        ) : !workspaceId ? (
          <p className="text-sm text-muted-foreground">{t('catalog.select_workspace_first')}</p>
        ) : (
          <div className="space-y-3 text-sm">
            {isUpdate ? (
              <>
                <p className="text-muted-foreground">
                  {t('catalog.update_confirm', {
                    from: installed?.version ?? t('catalog.version_unknown'),
                    to: entry?.version ?? t('catalog.version_unknown'),
                  })}
                </p>
                <p className="text-muted-foreground">{t('catalog.update_choice_hint')}</p>
              </>
            ) : (
              <p className="text-muted-foreground">
                {t('catalog.install_confirm', { workspace: workspaceName })}
              </p>
            )}

            {error && <GitErrorInline message={t('catalog.install_failed')} detail={error} />}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={installing}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            className="gap-1"
            onClick={handleInstall}
            disabled={!serverMode || !workspaceId || installing}
          >
            {installing
              ? <><Loader2 size={14} className="animate-spin" />{t('catalog.installing')}</>
              : isUpdate
                ? <><Upload size={14} />{t('catalog.update')}</>
                : <><Download size={14} />{t('catalog.install')}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
