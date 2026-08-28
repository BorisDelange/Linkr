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
import { commitCatalogInstall, prepareCatalogInstall, type InstallFailure, type PreparedInstall } from '@/lib/catalog/install'
import { refreshStoresAfterInstall } from '@/lib/catalog/refresh'
import { useAppStore } from '@/stores/app-store'
import type { InstalledInfo } from '@/lib/catalog/installed'
import type { CatalogEntry } from '@/lib/catalog/types'

export interface CatalogInstallFailure {
  entry: CatalogEntry
  detail: string
  /** The entity IS installed; this reports what part of it did not arrive. */
  partial?: boolean
}

/** An already-installed entry awaiting "yes, install it again". */
export interface CatalogReinstall {
  entry: CatalogEntry
  /** Version currently installed in the target workspace, if it declares one. */
  localVersion?: string
  /** True when the catalog is ahead — the dialog then reads as an update. */
  outdated: boolean
}

export interface CatalogInstallState {
  /** Entry currently being cloned/written — the card shows a spinner for it. */
  busyId: string | null
  /** Already-installed entry awaiting confirmation. */
  reinstall: CatalogReinstall | null
  /** Cloned repo awaiting a duplicate-or-overwrite answer. */
  conflict: PreparedInstall | null
  /** Last failure, shown in a dialog since a card has no room for a git error. */
  failure: CatalogInstallFailure | null
  /** `installed` is the local copy in the target workspace, when there is one. */
  install: (entry: CatalogEntry, installed?: InstalledInfo) => Promise<void>
  /** Proceed with the held install: `duplicate` keeps the existing copy alongside. */
  confirmReinstall: (duplicate: boolean) => Promise<void>
  dismissReinstall: () => void
  /** Answer the conflict prompt. */
  resolveConflict: (duplicate: boolean) => Promise<void>
  dismissConflict: () => void
  dismissFailure: () => void
}

/**
 * A sentence for the failure modes that carry no raw error of their own.
 *
 * `clone-failed` and `apply-failed` always set one (the git output, or the
 * layout diagnosis from install.ts), so they are not listed here — falling back
 * to the dialog's own title left the user reading the same words three times.
 */
function failureText(t: (k: string) => string, failure?: InstallFailure): string {
  switch (failure) {
    case 'server-mode-required': return t('catalog.install_needs_server')
    case 'unsupported-type': return t('catalog.install_unsupported_type')
    default: return t('catalog.install_failed')
  }
}

/**
 * `onInstalled` receives the local id the install wrote — `project.uid`, or the
 * workspace id for a `workspace` entry, which is the only way a caller can learn
 * what a workspace install created (it mints its own row and takes no target).
 * Existing callers ignore the argument and only use it as a "reload now" signal.
 */
export function useCatalogInstall(
  workspaceId: string,
  onInstalled: (installedId?: string) => void,
): CatalogInstallState {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [reinstall, setReinstall] = useState<CatalogReinstall | null>(null)
  const [conflict, setConflict] = useState<PreparedInstall | null>(null)
  const [failure, setFailure] = useState<CatalogInstallFailure | null>(null)

  const commit = useCallback(
    async (prepared: PreparedInstall, duplicate: boolean) => {
      setBusyId(prepared.entry.id)
      try {
        const result = await commitCatalogInstall(prepared, workspaceId, language, duplicate)
        if (!result.ok) {
          setFailure({ entry: prepared.entry, detail: result.error ?? failureText(t, result.failure) })
          return
        }
        // Cloned rows land straight in storage, so any store already holding a list of
        // this entity type is stale until reloaded.
        // A workspace install has no target workspace — the one it just created
        // IS the scope, and passing the empty target would reload every
        // workspace's presets into the store.
        await refreshStoresAfterInstall(
          prepared.entry.type,
          prepared.entry.type === 'workspace' ? (result.id ?? workspaceId) : workspaceId,
        )
        // Installed, but not whole: a workspace whose children could not be cloned
        // arrives as a set of empty entities, and saying nothing read as success.
        if (result.warning) {
          setFailure({ entry: prepared.entry, detail: result.warning, partial: true })
        }
        onInstalled(result.id)
      } catch (err) {
        setFailure({ entry: prepared.entry, detail: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusyId(null)
      }
    },
    [workspaceId, language, t, onInstalled],
  )

  /** Clone and write. Assumes any confirmation has already been given. */
  const run = useCallback(
    async (entry: CatalogEntry, duplicate = false, answered = false) => {
      setFailure(null)
      setBusyId(entry.id)
      try {
        // Clone first, then check for a collision: the id that decides it is declared
        // by the repo, so it is not knowable before the clone.
        const prep = await prepareCatalogInstall(entry, workspaceId)
        if (!prep.ok) {
          setFailure({ entry, detail: prep.error ?? failureText(t, prep.failure) })
          return
        }
        // The re-install dialog already asked overwrite-or-duplicate for an entry the
        // catalog recognised as installed, so only an UNrecognised collision still needs
        // the prompt — and it is only knowable after the clone.
        if (prep.prepared.existingName && !answered) {
          // commit() takes over the busy state once the user answers.
          setConflict(prep.prepared)
          return
        }
        await commit(prep.prepared, duplicate)
      } catch (err) {
        setFailure({ entry, detail: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusyId((id) => (id === entry.id ? null : id))
      }
    },
    [t, commit, workspaceId],
  )

  const install = useCallback(
    async (entry: CatalogEntry, installed?: InstalledInfo) => {
      // A workspace needs no target workspace — it is created at instance level.
      if ((!workspaceId && entry.type !== 'workspace') || busyId) return
      // Already installed: ask first. Re-installing overwrites or duplicates a copy the
      // user already has, and which version replaces which is exactly what they need to
      // see. A first install has nothing to weigh, so it writes on click.
      if (installed) {
        setReinstall({
          entry,
          localVersion: installed.version,
          outdated: installed.state === 'outdated',
        })
        return
      }
      await run(entry)
    },
    [workspaceId, busyId, run],
  )

  const confirmReinstall = useCallback(
    async (duplicate: boolean) => {
      const pending = reinstall
      setReinstall(null)
      if (pending) await run(pending.entry, duplicate, true)
    },
    [reinstall, run],
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
    reinstall,
    conflict,
    failure,
    install,
    confirmReinstall,
    dismissReinstall: () => setReinstall(null),
    resolveConflict,
    dismissConflict: () => setConflict(null),
    dismissFailure: () => setFailure(null),
  }
}
