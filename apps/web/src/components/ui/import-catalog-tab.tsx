/**
 * The "From the catalog" tab of the import dialog.
 *
 * Installing from the community catalog is a third import source alongside a ZIP upload
 * and a git clone, so it belongs in the same dialog rather than only on the Catalog page.
 * It renders the very same browse surface — `CatalogBrowser`: toolbar, filters, sort and
 * the real entry cards — narrowed to the type the calling page imports. Only the type
 * filter is dropped, since the entries are already all of one type.
 *
 * The dialog widens on this tab (see ImportSourceDialog): those cards need room, and a
 * grid of them in a 512px modal was what made the first version overflow.
 *
 * The install path is the shared one (`useCatalogInstall`), so the confirmation, conflict
 * and failure dialogs behave exactly as on the Catalog page; the caller renders them.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { isServerMode } from '@/lib/api-client'
import { findInstalled, type InstalledInfo } from '@/lib/catalog/installed'
import { useCatalog } from '@/hooks/use-catalog'
import { CatalogBrowser } from '@/features/catalog/CatalogBrowser'
import { useOpenInstalled } from '@/features/catalog/use-open-installed'
import type { CatalogEntryType } from '@/lib/catalog/types'
import type { CatalogInstallState } from '@/features/catalog/use-catalog-install'

interface ImportCatalogTabProps {
  /** Only entries of this type are listed. */
  type: CatalogEntryType
  workspaceId: string
  install: CatalogInstallState
  language: string
  /** Bumped by the caller after an install, to re-read what is installed. */
  installedNonce: number
  /** Close the host dialog — called before navigating to an installed entity. */
  onClose: () => void
}

export function ImportCatalogTab({ type, workspaceId, install, language, installedNonce, onClose }: ImportCatalogTabProps) {
  const { t } = useTranslation()
  const { entries, loaded, loading, error, load } = useCatalog()
  const [installed, setInstalled] = useState<Record<string, InstalledInfo>>({})
  const openInApp = useOpenInstalled(workspaceId, onClose)

  const ofType = useMemo(() => entries.filter((e) => e.type === type), [entries, type])

  // Same external-system sync as the Catalog page: only storage can answer this.
  useEffect(() => {
    let cancelled = false
    // A `workspace` entry is answerable with no workspace selected — it is the
    // scope rather than living in one (see the same guard on CatalogPage).
    const answerable = workspaceId || type === 'workspace'
    const lookup = !answerable || !ofType.length
      ? Promise.resolve({})
      : findInstalled(ofType, workspaceId)
    void lookup.then((found) => { if (!cancelled) setInstalled(found) })
    return () => { cancelled = true }
  }, [ofType, type, workspaceId, installedNonce])

  // Server mode is checked before anything else: without a backend nothing here can be
  // installed, so listing entries would only offer actions that cannot run.
  if (!isServerMode()) {
    return (
      <div className="flex h-[320px] items-center justify-center">
        <ServerModeNotice inline className="mx-auto" />
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="flex h-[320px] flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 p-8">
        <Store size={32} className="text-muted-foreground/50" />
        <p className="mt-3 text-center text-sm text-muted-foreground">{t('catalog.not_loaded')}</p>
        <Button size="sm" className="mt-4 gap-1" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {t('catalog.load')}
        </Button>
        {error && (
          <p className="mt-3 text-xs text-destructive">{t(`catalog.error_${error.replace(/-/g, '_')}`)}</p>
        )}
      </div>
    )
  }

  return (
    // Scrolls inside the tab so the dialog itself keeps a fixed height as the user
    // filters — the toolbar stays put instead of the modal resizing under the pointer.
    <div className="max-h-[60vh] min-w-0 overflow-y-auto overflow-x-hidden">
      <CatalogBrowser
        entries={ofType}
        language={language}
        installed={installed}
        serverMode
        hasWorkspace={!!workspaceId}
        busyId={install.busyId}
        onInstall={(entry) => void install.install(entry, installed[entry.id])}
        // Same behaviour as the Catalog page: once installed, the card and its `⋯`
        // menu open the entity itself. The hook closes this dialog first, so the
        // overlay doesn't linger over the page it navigates to.
        openInApp={(entry) => openInApp(entry, installed[entry.id])}
        lockedType={type}
        gridClassName="sm:grid-cols-2"
      />
    </div>
  )
}
