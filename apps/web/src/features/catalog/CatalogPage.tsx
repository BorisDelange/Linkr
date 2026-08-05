import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, ExternalLink, Loader2, RefreshCw, Store, Upload } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { isServerMode } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { getCatalogSource } from '@/lib/catalog/settings'
import { ENTRY_TYPES, ENTRY_TYPE_META } from '@/lib/catalog/entry-meta'
import { findInstalled, type InstalledInfo } from '@/lib/catalog/installed'
import { useCatalog } from '@/hooks/use-catalog'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CatalogInstallDialog } from './CatalogInstallDialog'
import type { CatalogEntry } from '@/lib/catalog/types'

/** Organization label used by the filter list, the filter test and the search haystack. */
function orgNameOf(entry: CatalogEntry, language: string): string {
  return localized(entry.organization?.name, language) || ''
}

export function CatalogPage() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { entries, loaded, loading, error, fetchedAt, update, load, refresh } = useCatalog()

  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [authorFilter, setAuthorFilter] = useState<string[]>([])
  const [orgFilter, setOrgFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)
  const [installing, setInstalling] = useState<CatalogEntry | null>(null)

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  /** Explicit pick only; the effective workspace is derived below. */
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState('')
  /** Installed copies in the selected workspace, keyed by catalog entry id. */
  const [installed, setInstalled] = useState<Record<string, InstalledInfo>>({})
  /** Bumped after an install to re-read storage; nothing else changes. */
  const [installedNonce, setInstalledNonce] = useState(0)

  const serverMode = isServerMode()
  const source = getCatalogSource()

  useEffect(() => { void loadWorkspaces() }, [loadWorkspaces])

  // Derived, not synced into state: falls back to the workspace the user was last in,
  // then to the only one there is, so the common single-workspace case never forces a
  // pick. A stale pick (workspace deleted) resolves back to the fallback on its own.
  const workspaceId = useMemo(() => {
    if (pickedWorkspaceId && workspaces.some((w) => w.id === pickedWorkspaceId)) return pickedWorkspaceId
    if (activeWorkspaceId && workspaces.some((w) => w.id === activeWorkspaceId)) return activeWorkspaceId
    return workspaces.length === 1 ? workspaces[0]!.id : ''
  }, [pickedWorkspaceId, workspaces, activeWorkspaceId])

  // Which entries are already installed can only be answered by reading storage, so it
  // is a genuine external-system sync rather than derivable state.
  useEffect(() => {
    let cancelled = false
    const lookup = !workspaceId || !entries.length
      ? Promise.resolve({})
      : findInstalled(entries, workspaceId)
    void lookup.then((found) => { if (!cancelled) setInstalled(found) })
    return () => { cancelled = true }
  }, [entries, workspaceId, installedNonce])

  const allBadges = useMemo(
    () => [...new Set(entries.flatMap((e) => e.badges ?? []))].sort(),
    [entries],
  )
  const allAuthors = useMemo(
    () => [...new Set(entries.map((e) => e.author?.name).filter((n): n is string => !!n))].sort(),
    [entries],
  )
  const allOrgs = useMemo(
    () => [...new Set(entries.map((e) => orgNameOf(e, language)).filter(Boolean))].sort(),
    [entries, language],
  )

  const filtered = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const result = entries.filter((e) => {
      if (typeFilter.length && !typeFilter.includes(e.type)) return false
      if (badgeFilter.length && !(e.badges ?? []).some((b) => badgeFilter.includes(b))) return false
      if (authorFilter.length && !(e.author?.name && authorFilter.includes(e.author.name))) return false
      if (orgFilter.length && !orgFilter.includes(orgNameOf(e, language))) return false
      if (!words.length) return true
      const haystack = [
        localized(e.name, language),
        localized(e.description, language),
        e.author?.name ?? '',
        orgNameOf(e, language),
        ...(e.badges ?? []),
      ].join(' ').toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
    return applySort(result, sort, {
      name: (e) => localized(e.name, language),
      createdAt: (e) => e.createdAt ?? '',
      updatedAt: (e) => e.updatedAt ?? '',
    })
  }, [entries, searchQuery, typeFilter, badgeFilter, authorFilter, orgFilter, sort, language])

  const filterGroups: FilterGroup[] = [
    {
      key: 'type',
      label: t('catalog.filter_type'),
      options: ENTRY_TYPES.filter((ty) => entries.some((e) => e.type === ty))
        .map((ty) => ({
          value: ty,
          label: t(ENTRY_TYPE_META[ty].labelKey),
          icon: ENTRY_TYPE_META[ty].icon,
          iconClass: ENTRY_TYPE_META[ty].color,
        })),
      selected: typeFilter,
      onChange: setTypeFilter,
    },
    {
      key: 'badges',
      label: t('catalog.filter_badges'),
      options: allBadges.map((b) => ({ value: b, label: b })),
      selected: badgeFilter,
      onChange: setBadgeFilter,
    },
    {
      key: 'author',
      label: t('catalog.filter_author'),
      options: allAuthors.map((a) => ({ value: a, label: a })),
      selected: authorFilter,
      onChange: setAuthorFilter,
    },
    {
      key: 'organization',
      label: t('catalog.filter_organization'),
      options: allOrgs.map((o) => ({ value: o, label: o })),
      selected: orgFilter,
      onChange: setOrgFilter,
    },
  ]

  const updateSummary = () => {
    if (!update) return ''
    const parts: string[] = []
    if (update.added.length) parts.push(t('catalog.update_new', { count: update.added.length }))
    if (update.modified.length) parts.push(t('catalog.update_modified', { count: update.modified.length }))
    if (update.removed.length) parts.push(t('catalog.update_removed', { count: update.removed.length }))
    return parts.join(', ')
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t('catalog.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('catalog.description')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('catalog.contribute')}{' '}
              <a
                href={source.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {source.project}
                <ExternalLink size={11} />
              </a>
            </p>
          </div>
          {loaded && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('catalog.last_updated', { date: formatDate(fetchedAt, language) })}
              </span>
              <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={refresh} disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t('catalog.refresh')}
              </Button>
            </div>
          )}
        </div>

        {loaded && update && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-foreground">{t('catalog.updates_available', { summary: updateSummary() })}</span>
            <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={refresh} disabled={loading}>
              {t('catalog.update_now')}
            </Button>
          </div>
        )}

        {!serverMode && loaded && (
          <div className="mt-4">
            <ServerModeNotice inline description={t('catalog.install_requires_server')} />
          </div>
        )}

        {loaded && entries.length > 0 && (
          <ListPageToolbar
            className="mt-6"
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('common.search')}
            filterGroups={filterGroups}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          >
            {/* Installing targets one workspace, and whether an entry is already
                installed is answered per workspace — so the choice belongs here, next
                to the list it qualifies, rather than inside the install dialog. */}
            {serverMode && workspaces.length > 0 && (
              <Select value={workspaceId} onValueChange={setPickedWorkspaceId}>
                <SelectTrigger className="h-9 w-52 shrink-0" aria-label={t('catalog.install_workspace')}>
                  <SelectValue placeholder={t('catalog.install_workspace_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((ws) => (
                    <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </ListPageToolbar>
        )}

        {!loaded ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Store size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">{t('catalog.not_loaded')}</p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('catalog.not_loaded_description', { host: source.host })}
              </p>
              <Button size="sm" className="mt-4 gap-1" onClick={load} disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('catalog.load')}
              </Button>
              {error && (
                <p className="mt-3 text-xs text-destructive">{t(`catalog.error_${error.replace(/-/g, '_')}`)}</p>
              )}
            </div>
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <p className="text-sm text-muted-foreground">
                {entries.length === 0 ? t('catalog.empty') : t('common.no_results')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {filtered.map((entry) => (
              <CatalogEntryCard
                key={entry.id}
                entry={entry}
                language={language}
                onInstall={() => setInstalling(entry)}
                canInstall={serverMode}
                hasWorkspace={!!workspaceId}
                installed={installed[entry.id]}
              />
            ))}
          </div>
        )}

        {error && loaded && (
          <p className="mt-3 text-xs text-destructive">{t(`catalog.error_${error.replace(/-/g, '_')}`)}</p>
        )}

      </div>

      <CatalogInstallDialog
        entry={installing}
        workspaceId={workspaceId}
        installed={installing ? installed[installing.id] : undefined}
        onOpenChange={(open) => { if (!open) setInstalling(null) }}
        onInstalled={() => setInstalledNonce((n) => n + 1)}
      />
    </div>
  )
}

interface CatalogEntryCardProps {
  entry: CatalogEntry
  language: string
  canInstall: boolean
  /** False when no workspace is selected — the action is shown but disabled. */
  hasWorkspace: boolean
  /** Set when this entry is already installed in the selected workspace. */
  installed?: InstalledInfo
  onInstall: () => void
}

function CatalogEntryCard({ entry, language, canInstall, hasWorkspace, installed, onInstall }: CatalogEntryCardProps) {
  const { t } = useTranslation()
  const name = localized(entry.name, language) || entry.id
  const description = localized(entry.description, language)
  const state = installed?.state ?? 'not-installed'
  const meta = ENTRY_TYPE_META[entry.type]
  const typeLabel = t(meta.labelKey)
  const Icon = meta.icon

  return (
    <Card
      role="link"
      tabIndex={0}
      title={t('catalog.open_repository')}
      onClick={() => window.open(entry.git.url, '_blank', 'noopener,noreferrer')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          window.open(entry.git.url, '_blank', 'noopener,noreferrer')
        }
      }}
      className="flex min-h-52 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
    >
      {/* Same skeleton as the workspace cards: one `px-4 pt-5` column (no bottom
          padding — CardMetaFooter's own pt-2 closes the card), a flex-1 content block,
          then the footer pinned below it — Install rides in the footer's trailing slot. */}
      <div className="flex min-w-0 flex-1 flex-col px-4 pt-5">
        <div className="flex flex-1 flex-col">
          {/* Same icon + title row the entity's OWN list page draws, so a catalog card
              reads as the kind of object it installs. The type badge is gone: the icon
              carries that, with the label in its tooltip. */}
          <div className="flex items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', meta.bg)}>
                  <Icon size={20} className={meta.color} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{typeLabel}</TooltipContent>
            </Tooltip>
            {/* min-w-0 is what makes the truncation bite: without it the flex item takes
                its content width and pushes the version badge out of the card. */}
            <div className="min-w-0 flex-1">
              <TruncatedText text={name} className="text-sm font-medium" />
            </div>
            {entry.version && (
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">v{entry.version}</Badge>
            )}
          </div>

          {/* Fixed height like the workspace cards: the row is reserved whether or not
              there's a description, so every card's lower half lines up. Truncated with
              the full text in a hover tooltip. */}
          <div className="mt-2 h-8">
            {description ? (
              <TruncatedText text={description} lines={2} className="text-xs text-muted-foreground" />
            ) : (
              <p className="text-xs italic text-muted-foreground/70">{t('catalog.no_description')}</p>
            )}
          </div>

          <div className="mt-1.5 flex h-5 items-center gap-1 overflow-hidden">
            {entry.status && (
              <Badge
                variant="outline"
                className="shrink-0 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
              >
                {t(`catalog.status_${entry.status}`)}
              </Badge>
            )}
            {(entry.badges ?? []).map((b) => (
              <Badge key={b} variant="outline" className="max-w-32 shrink-0 truncate text-[10px]">{b}</Badge>
            ))}
          </div>
        </div>

        <CardMetaFooter
          className="mt-2"
          createdBy={entry.author?.name}
          createdByDetails={entry.author ? { orcid: entry.author.orcid, affiliation: entry.author.affiliation } : undefined}
          organization={entry.organization ? { ...entry.organization, name: entry.organization.name ?? '' } : undefined}
          createdAt={entry.createdAt}
          updatedAt={entry.updatedAt}
          // The footer already swallows clicks, so the button can't reach the card's
          // open-the-repo handler.
          trailing={canInstall && (
            <EntryAction
              state={state}
              hasWorkspace={hasWorkspace}
              localVersion={installed?.version}
              onClick={onInstall}
            />
          )}
        />
      </div>
    </Card>
  )
}

interface EntryActionProps {
  state: 'not-installed' | 'installed' | 'outdated'
  hasWorkspace: boolean
  localVersion?: string
  onClick: () => void
}

/**
 * The card's install action, in one of three states.
 *
 * "Installed" stays clickable: re-installing an up-to-date entry is legitimate (restoring
 * a locally-broken copy), it just isn't advertised — hence the muted outline. The
 * duplicate-or-overwrite prompt still guards the write in every case.
 */
function EntryAction({ state, hasWorkspace, localVersion, onClick }: EntryActionProps) {
  const { t } = useTranslation()

  const label = state === 'outdated'
    ? t('catalog.update')
    : state === 'installed' ? t('catalog.installed') : t('catalog.install')
  const Icon = state === 'outdated' ? Upload : state === 'installed' ? Check : Download

  const button = (
    <Button
      size="sm"
      // Update is the call to action, so it keeps the filled default; an already-installed
      // entry recedes to an outline so a screenful of them doesn't read as a screenful of
      // primary actions.
      variant={state === 'installed' ? 'outline' : 'default'}
      className="h-6 gap-1 px-2 text-xs"
      disabled={!hasWorkspace}
      onClick={onClick}
    >
      <Icon size={12} />
      {label}
    </Button>
  )

  const hint = !hasWorkspace
    ? t('catalog.select_workspace_first')
    : state === 'outdated'
      ? t('catalog.update_from_version', { version: localVersion ?? '—' })
      : state === 'installed'
        ? t('catalog.installed_hint')
        : null
  if (!hint) return button

  return (
    <Tooltip>
      {/* A disabled button fires no pointer events, so the trigger needs a wrapper to
          stay hoverable — otherwise the "pick a workspace" hint never shows. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">{hint}</TooltipContent>
    </Tooltip>
  )
}
