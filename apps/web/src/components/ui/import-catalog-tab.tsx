/**
 * The "From the catalog" tab of the import dialog.
 *
 * Installing from the community catalog is a third import source alongside a ZIP upload
 * and a git clone, so it belongs in the same dialog rather than only on the Catalog page.
 * This is a narrowed view of that page: entries of the dialog's own type, in the current
 * workspace, with a search box — the type filter, the sort and the per-entry cards would
 * be noise here, where the user already said what they came to import.
 *
 * The install path is the shared one (`useCatalogInstall`), so the confirmation, conflict
 * and failure dialogs behave exactly as on the Catalog page; the caller renders them.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Loader2, Search, Store, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { TruncatedText } from '@/components/ui/truncated-text'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { findInstalled, type InstalledInfo } from '@/lib/catalog/installed'
import { useCatalog } from '@/hooks/use-catalog'
import type { CatalogEntry, CatalogEntryType } from '@/lib/catalog/types'
import type { CatalogInstallState } from '@/features/catalog/use-catalog-install'

interface ImportCatalogTabProps {
  /** Only entries of this type are listed. */
  type: CatalogEntryType
  workspaceId: string
  install: CatalogInstallState
  language: string
  /** Bumped by the caller after an install, to re-read what is installed. */
  installedNonce: number
}

export function ImportCatalogTab({ type, workspaceId, install, language, installedNonce }: ImportCatalogTabProps) {
  const { t } = useTranslation()
  const { entries, loaded, loading, error, load } = useCatalog()
  const [query, setQuery] = useState('')
  const [installed, setInstalled] = useState<Record<string, InstalledInfo>>({})

  const ofType = useMemo(() => entries.filter((e) => e.type === type), [entries, type])

  // Same external-system sync as the Catalog page: only storage can answer this.
  useEffect(() => {
    let cancelled = false
    const lookup = !workspaceId || !ofType.length
      ? Promise.resolve({})
      : findInstalled(ofType, workspaceId)
    void lookup.then((found) => { if (!cancelled) setInstalled(found) })
    return () => { cancelled = true }
  }, [ofType, workspaceId, installedNonce])

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return ofType
    return ofType.filter((e) => {
      const haystack = [
        localized(e.name, language),
        localized(e.description, language),
        e.author?.name ?? '',
      ].join(' ').toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
  }, [ofType, query, language])

  // Server mode is checked before anything else: without a backend nothing here can be
  // installed, so listing entries would only offer actions that cannot run.
  if (!isServerMode()) {
    return (
      <div className="flex h-[214px] items-center justify-center">
        <ServerModeNotice inline className="mx-auto" />
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="flex h-[214px] flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 p-8">
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
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('common.search')}
          className="h-9 pl-8 text-sm"
        />
      </div>

      {/* Fixed height matching the other tabs, so switching tabs doesn't resize the modal. */}
      <div className="h-[180px] overflow-y-auto rounded-lg border">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4">
            <p className="text-center text-xs text-muted-foreground">
              {ofType.length === 0 ? t('import_source.catalog_empty') : t('common.no_results')}
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                language={language}
                installed={installed[entry.id]}
                busy={install.busyId === entry.id}
                disabled={!workspaceId || !!install.busyId}
                onInstall={() => void install.install(entry, installed[entry.id])}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function CatalogRow({
  entry,
  language,
  installed,
  busy,
  disabled,
  onInstall,
}: {
  entry: CatalogEntry
  language: string
  installed?: InstalledInfo
  busy: boolean
  disabled: boolean
  onInstall: () => void
}) {
  const { t } = useTranslation()
  const state = installed?.state ?? 'not-installed'
  const name = localized(entry.name, language) || entry.id
  const description = localized(entry.description, language)

  const label = state === 'outdated'
    ? t('catalog.update')
    : state === 'installed' ? t('catalog.installed') : t('catalog.install')
  const Icon = state === 'outdated' ? Upload : state === 'installed' ? Check : Download

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{name}</span>
          {entry.version && (
            <Badge variant="outline" className="shrink-0 font-mono">v{entry.version}</Badge>
          )}
        </div>
        {description && (
          <TruncatedText text={description} className="mt-0.5 text-[10px] text-muted-foreground" />
        )}
      </div>
      <Button
        size="sm"
        variant={state === 'installed' ? 'outline' : 'default'}
        className="h-6 shrink-0 gap-1 px-2 text-xs"
        disabled={disabled}
        onClick={onInstall}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
        {busy ? t('catalog.installing') : label}
      </Button>
    </li>
  )
}
