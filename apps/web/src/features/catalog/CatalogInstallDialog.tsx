import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { GitErrorInline } from '@/components/versioning/GitErrorInline'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { commitCatalogInstall, prepareCatalogInstall, type PreparedInstall } from '@/lib/catalog/install'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { CatalogEntry } from '@/lib/catalog/types'

interface CatalogInstallDialogProps {
  entry: CatalogEntry | null
  onOpenChange: (open: boolean) => void
  onInstalled?: (entry: CatalogEntry, id: string) => void
}

/**
 * Asks which workspace to install into, then clones the entry's repo.
 *
 * Every catalog type belongs to a workspace, so the picker applies to all of them.
 * The clone itself is `installCatalogEntry` → the shared git-linked-entity path, not a
 * second import implementation.
 */
export function CatalogInstallDialog({ entry, onOpenChange, onInstalled }: CatalogInstallDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)

  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Cloned repo awaiting a duplicate-or-overwrite answer. */
  const [conflict, setConflict] = useState<PreparedInstall | null>(null)

  const serverMode = isServerMode()

  // Default to the workspace the user was last in, else the only one, else nothing.
  useEffect(() => {
    if (!entry) return
    setError(null)
    const preferred = activeWorkspaceId && workspaces.some((w) => w.id === activeWorkspaceId)
      ? activeWorkspaceId
      : workspaces.length === 1 ? workspaces[0]!.id : ''
    setWorkspaceId(preferred)
  }, [entry, activeWorkspaceId, workspaces])

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
          <DialogTitle>{t('catalog.install_title')}</DialogTitle>
          <DialogDescription>
            {entry ? localized(entry.name, language) : ''}
          </DialogDescription>
        </DialogHeader>

        {!serverMode ? (
          <ServerModeNotice inline description={t('catalog.install_requires_server')} />
        ) : workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('catalog.install_no_workspace')}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="catalog-install-ws">{t('catalog.install_workspace')}</Label>
              <Select value={workspaceId} onValueChange={setWorkspaceId} disabled={installing}>
                <SelectTrigger id="catalog-install-ws">
                  <SelectValue placeholder={t('catalog.install_workspace_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((ws) => (
                    <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
              : <><Download size={14} />{t('catalog.install')}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
