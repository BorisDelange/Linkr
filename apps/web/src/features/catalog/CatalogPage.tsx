import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Check, Download, ExternalLink, FolderOpen, Loader2, MoreHorizontal, RefreshCw, Store, Upload } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { isServerMode } from '@/lib/api-client'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { formatDate } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { paths } from '@/lib/paths'
import { getCatalogSource, loadCatalogTargetWorkspace, saveCatalogTargetWorkspace } from '@/lib/catalog/settings'
import { ENTRY_TYPES, ENTRY_TYPE_META } from '@/lib/catalog/entry-meta'
import { findInstalled, type InstalledInfo } from '@/lib/catalog/installed'
import { useCatalog } from '@/hooks/use-catalog'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CatalogInstallOutcome } from './CatalogInstallDialog'
import { useCatalogInstall } from './use-catalog-install'
import type { CatalogEntry } from '@/lib/catalog/types'
import type { EntityLicense } from '@/types'

/** Organization label used by the filter list, the filter test and the search haystack. */
function orgNameOf(entry: CatalogEntry, language: string): string {
  return localized(entry.organization?.name, language) || ''
}

export function CatalogPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const language = useAppStore((s) => s.language)
  const { entries, loaded, loading, error, fetchedAt, update, load, refresh } = useCatalog()

  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [authorFilter, setAuthorFilter] = useState<string[]>([])
  const [orgFilter, setOrgFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  /** Explicit pick only; the effective workspace is derived below. Restored from
   *  localStorage so leaving the page and coming back keeps the chosen target. */
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState(loadCatalogTargetWorkspace)
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

  // Installing writes straight from the card; only a conflict or a failure opens a dialog.
  const bumpInstalled = useCallback(() => setInstalledNonce((n) => n + 1), [])
  const inst = useCatalogInstall(workspaceId, bumpInstalled)

  /**
   * Where an installed entity lives in the app — the entity itself, not the list page
   * it sits on. Types with no detail route of their own (sql collections, data
   * catalogs) return undefined, and their card keeps opening the repo, which is more
   * useful than a list that does not say which row was just installed.
   */
  const openInApp = useCallback(
    (entry: CatalogEntry, info?: InstalledInfo): (() => void) | undefined => {
      if (!info || !workspaceId) return undefined
      const to =
        entry.type === 'project' ? paths.projectSummary(workspaceId, info.id)
        : entry.type === 'mapping-project' ? paths.warehouseConceptMappingProject(workspaceId, info.id)
        : entry.type === 'etl-pipeline' ? paths.warehouseEtlPipeline(workspaceId, info.id)
        : entry.type === 'dq-rule-set' ? paths.warehouseDqRuleSet(workspaceId, info.id)
        : entry.type === 'schema-preset' ? paths.warehouseSchema(workspaceId, info.id)
        : null
      return to ? () => navigate(to) : undefined
    },
    [workspaceId, navigate],
  )

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
                {t('catalog.last_updated', { date: formatDate(fetchedAt ?? undefined, language) })}
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
              <Select
                value={workspaceId}
                onValueChange={(id) => { setPickedWorkspaceId(id); saveCatalogTargetWorkspace(id) }}
              >
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
                onInstall={() => void inst.install(entry, installed[entry.id])}
                busy={inst.busyId === entry.id}
                onOpen={openInApp(entry, installed[entry.id])}
                serverMode={serverMode}
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

      <CatalogInstallOutcome install={inst} language={language} />
    </div>
  )
}

/**
 * Open a catalog entry's repo. The URL is remote, untrusted data; only http(s)
 * may reach window.open (a `javascript:`/`data:` url would run in this origin).
 * fetchCatalog already drops non-https entries — this is defence in depth.
 */
function openRepo(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

interface CatalogEntryCardProps {
  entry: CatalogEntry
  language: string
  /** False in client-only mode: the action shows, disabled, explaining why. */
  serverMode: boolean
  /** False when no workspace is selected — the action is shown but disabled. */
  hasWorkspace: boolean
  /** Set when this entry is already installed in the selected workspace. */
  installed?: InstalledInfo
  onInstall: () => void
  /** This entry is being cloned/written right now. */
  busy: boolean
  /** Open the installed copy in the app; absent when this type has no page to open. */
  onOpen?: () => void
}

function CatalogEntryCard({ entry, language, serverMode, hasWorkspace, installed, onInstall, busy, onOpen }: CatalogEntryCardProps) {
  const { t } = useTranslation()
  const name = localized(entry.name, language) || entry.id
  const description = localized(entry.description, language)
  const state = installed?.state ?? 'not-installed'
  const meta = ENTRY_TYPE_META[entry.type]
  const typeLabel = t(meta.labelKey)
  const Icon = meta.icon

  // Clicking the card does the obvious thing for its state: an installed entity opens
  // where it lives in the app, an uninstalled one opens the repo it would come from.
  const activate = () => (onOpen ? onOpen() : openRepo(entry.git.url))

  return (
    <Card
      role="link"
      tabIndex={0}
      aria-label={onOpen ? t('catalog.open_in_app') : t('catalog.open_repository')}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      }}
      className="flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
    >
      {/* Deliberately the SAME skeleton as ListPageTemplate's card (min-h-44, the
          `px-4 pt-5` column, the `flex-1 items-center` body row, `mt-auto` on the
          footer): a catalog card must be visually interchangeable with the card of
          the entity it installs — same `⋯` menu on the title row, with the published
          version beside it. Install rides in the footer's trailing slot. */}
      <div className="flex flex-1 flex-col px-4 pt-5">
        <div className="flex flex-1 items-center gap-4">
          <div className="min-w-0 flex-1">
            {/* Icon + title row copied from the entity's own list page. No type badge:
                the icon carries that, with the label in its tooltip. */}
            <div className="flex items-center gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', meta.bg)}>
                    <Icon size={20} className={meta.color} />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{typeLabel}</TooltipContent>
              </Tooltip>
              <span className="truncate text-sm font-medium">{name}</span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {entry.version && (
                  <Badge variant="outline" className="font-mono">v{entry.version}</Badge>
                )}
                <EntryMenu entry={entry} installed={state !== 'not-installed'} onOpen={onOpen} />
              </div>
            </div>

            {/* h-4 and no placeholder, exactly like the list pages: an entity with no
                description leaves the row blank rather than saying so. */}
            <div className="mt-2 h-4">
              {description && (
                <TruncatedText text={description} className="text-xs text-muted-foreground" />
              )}
            </div>

            {(entry.status || (entry.badges ?? []).length > 0) && (
              <div className="mt-1.5 flex h-5 items-center gap-1 overflow-hidden">
                {entry.status && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  >
                    {t(`catalog.status_${entry.status}`)}
                  </Badge>
                )}
                {(entry.badges ?? []).map((b) => (
                  <Badge key={b} variant="outline" className="max-w-32 shrink-0 truncate">{b}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <CardMetaFooter
          className="mt-auto"
          createdBy={entry.author?.name}
          createdByDetails={entry.author ? { orcid: entry.author.orcid, affiliation: entry.author.affiliation } : undefined}
          organization={entry.organization ? { ...entry.organization, name: entry.organization.name ?? '' } : undefined}
          createdAt={entry.createdAt}
          updatedAt={entry.updatedAt}
          // This row already carries the Install button: the dates move into the
          // author tooltip so the licence has somewhere to sit.
          datesInAuthorTooltip
          // The index carries an SPDX id, not the text: shown, never opened. An entry
          // without one still shows "No license" — that absence is what a reuser
          // needs to see before installing.
          license={entry.license ? { id: entry.license as EntityLicense['id'], text: '' } : undefined}
          showLicenseWhenEmpty
          // The footer already swallows clicks, so the button can't reach the card's
          // open-the-repo handler.
          trailing={
            <InstallButton
              state={state}
              serverMode={serverMode}
              hasWorkspace={hasWorkspace}
              localVersion={installed?.version}
              busy={busy}
              onClick={onInstall}
            />
          }
        />
      </div>
    </Card>
  )
}

/**
 * The `⋯` menu on the title row — the same affordance every other entity card uses.
 *
 * A catalog entry has two useful destinations at once: the repo it comes from, and,
 * once installed, the entity in the app. A single control had to hide one of them.
 */
function EntryMenu({
  entry,
  installed,
  onOpen,
}: {
  entry: CatalogEntry
  installed: boolean
  onOpen?: () => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cardMenuTriggerClass}
          aria-label={t('common.actions')}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {installed && onOpen && (
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpen() }}>
            <FolderOpen size={14} />
            {t('catalog.open_in_app')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openRepo(entry.git.url) }}>
          <ExternalLink size={14} />
          {t('catalog.open_repository')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface InstallButtonProps {
  state: 'not-installed' | 'installed' | 'outdated'
  serverMode: boolean
  hasWorkspace: boolean
  localVersion?: string
  busy: boolean
  onClick: () => void
}

/**
 * The card's install action, in the footer's trailing slot.
 *
 * Clicking writes immediately — the card already carries everything a confirm dialog
 * would have restated — so while it runs the button itself is the progress indicator.
 * "Installed" stays clickable: re-installing an up-to-date entry is legitimate
 * (restoring a locally-broken copy), it just isn't advertised, hence the muted
 * outline. The duplicate-or-overwrite prompt still guards the write in every case.
 *
 * In client-only mode the button is still rendered, disabled, with the reason in its
 * tooltip — a greyed control on each card says "this entry could be installed, but not
 * here" far more precisely than one banner above the whole list.
 */
function InstallButton({ state, serverMode, hasWorkspace, localVersion, busy, onClick }: InstallButtonProps) {
  const { t } = useTranslation()

  const label = state === 'outdated'
    ? t('catalog.update')
    : state === 'installed' ? t('catalog.installed') : t('catalog.install')
  const Icon = state === 'outdated' ? Upload : state === 'installed' ? Check : Download
  const disabled = !serverMode || !hasWorkspace || busy

  const button = (
    <Button
      size="sm"
      // Update is the call to action, so it keeps the filled default; an already-installed
      // entry recedes to an outline so a screenful of them doesn't read as a screenful of
      // primary actions.
      variant={state === 'installed' ? 'outline' : 'default'}
      className="h-6 gap-1 px-2 text-xs"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
      {busy ? t('catalog.installing') : label}
    </Button>
  )

  // Server mode is checked first: without a backend, which workspace is selected is
  // moot, so "pick a workspace" would be misleading advice.
  const hint = busy
    ? null
    : !serverMode
      ? t('catalog.install_requires_server_short')
      : !hasWorkspace
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
      {/* max-w forces the longer hints to wrap instead of running off as one line. */}
      <TooltipContent side="top" className="max-w-56 text-xs">{hint}</TooltipContent>
    </Tooltip>
  )
}
