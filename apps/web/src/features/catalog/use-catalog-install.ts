/**
 * Install a catalog entry, straight from the card.
 *
 * Clicking Install writes immediately: the card already shows the name, version,
 * author, licence and target workspace, so a confirmation dialog restated what the
 * user just read and added a click to the common case. Two situations still need an
 * answer and keep a dialog, driven by the state returned here:
 *   - the repo collides with an entity already installed → duplicate or overwrite,
 *   - the clone or the write failed → the error, with its git detail.
 *
 * Reuses the same prepare/commit pair as before, so there is still exactly one
 * install implementation.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { commitCatalogInstall, prepareCatalogInstall, type PreparedInstall } from '@/lib/catalog/install'
import { refreshStoresAfterInstall } from '@/lib/catalog/refresh'
import { useAppStore } from '@/stores/app-store'
import type { CatalogEntry } from '@/lib/catalog/types'

export interface CatalogInstallFailure {
  entry: CatalogEntry
  detail: string
}

export interface CatalogInstallState {
  /** Entry currently being cloned/written — the card shows a spinner for it. */
  busyId: string | null
  /** Cloned repo awaiting a duplicate-or-overwrite answer. */
  conflict: PreparedInstall | null
  /** Last failure, shown in a dialog since a card has no room for a git error. */
  failure: CatalogInstallFailure | null
  install: (entry: CatalogEntry) => Promise<void>
  /** Answer the conflict prompt. */
  resolveConflict: (duplicate: boolean) => Promise<void>
  dismissConflict: () => void
  dismissFailure: () => void
}

export function useCatalogInstall(
  workspaceId: string,
  onInstalled: () => void,
): CatalogInstallState {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<PreparedInstall | null>(null)
  const [failure, setFailure] = useState<CatalogInstallFailure | null>(null)

  const commit = useCallback(
    async (prepared: PreparedInstall, duplicate: boolean) => {
      setBusyId(prepared.entry.id)
      try {
        const result = await commitCatalogInstall(prepared, workspaceId, language, duplicate)
        if (!result.ok) {
          setFailure({ entry: prepared.entry, detail: result.error ?? t('catalog.install_failed') })
          return
        }
        // Cloned rows land straight in storage, so any store already holding a list of
        // this entity type is stale until reloaded.
        await refreshStoresAfterInstall(prepared.entry.type, workspaceId)
        onInstalled()
      } catch (err) {
        setFailure({ entry: prepared.entry, detail: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusyId(null)
      }
    },
    [workspaceId, language, t, onInstalled],
  )

  const install = useCallback(
    async (entry: CatalogEntry) => {
      if (!workspaceId || busyId) return
      setFailure(null)
      setBusyId(entry.id)
      try {
        // Clone first, then check for a collision: the id that decides it is declared
        // by the repo, so it is not knowable before the clone.
        const prep = await prepareCatalogInstall(entry)
        if (!prep.ok) {
          setFailure({ entry, detail: prep.error ?? t('catalog.install_failed') })
          return
        }
        if (prep.prepared.existingName) {
          // commit() takes over the busy state once the user answers.
          setConflict(prep.prepared)
          return
        }
        await commit(prep.prepared, false)
      } catch (err) {
        setFailure({ entry, detail: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusyId((id) => (id === entry.id ? null : id))
      }
    },
    [workspaceId, busyId, t, commit],
  )

  const resolveConflict = useCallback(
    async (duplicate: boolean) => {
      const prepared = conflict
      setConflict(null)
      if (prepared) await commit(prepared, duplicate)
    },
    [conflict, commit],
  )

  return {
    busyId,
    conflict,
    failure,
    install,
    resolveConflict,
    dismissConflict: () => setConflict(null),
    dismissFailure: () => setFailure(null),
  }
}
