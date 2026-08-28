/**
 * One catalog entry, as a card.
 *
 * Deliberately the SAME skeleton as ListPageTemplate's card (min-h-44, the `px-4 pt-5`
 * column, the `flex-1 items-center` body row, `mt-auto` on the footer): a catalog card
 * must be visually interchangeable with the card of the entity it installs — same `⋯`
 * menu on the title row, with the published version beside it. Install rides in the
 * footer's trailing slot.
 *
 * Shared by the Catalog page and the import dialog's catalog tab.
 */
import { useTranslation } from 'react-i18next'
import { Check, Download, ExternalLink, FolderOpen, Loader2, MoreHorizontal, Upload } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { cardMenuTriggerClass, cn, isTypingTarget } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { humanBytes } from '@/lib/format-helpers'
import { ENTRY_TYPE_META } from '@/lib/catalog/entry-meta'
import type { InstalledInfo } from '@/lib/catalog/installed'
import type { CatalogEntry } from '@/lib/catalog/types'
import type { EntityLicense } from '@/types'

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

export function CatalogEntryCard({
  entry,
  language,
  serverMode,
  hasWorkspace,
  installed,
  onInstall,
  busy,
  onOpen,
}: CatalogEntryCardProps) {
  const { t, i18n } = useTranslation()
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
        if (isTypingTarget(e)) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      }}
      className="flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
    >
      <div className="flex flex-1 flex-col px-4 pt-3">
        {/* The grid mixes all eight types, and the icon alone doesn't say which is which.
            The badge names the type outright, in the icon's own hue. */}
        <Badge variant="outline" className={cn('mb-2 w-fit', meta.badge)}>{typeLabel}</Badge>
        <div className="flex flex-1 items-center gap-4">
          <div className="min-w-0 flex-1">
            {/* Icon + title row copied from the entity's own list page. */}
            <div className="flex min-w-0 items-center gap-3">
              <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', meta.bg)}>
                <Icon size={20} className={meta.color} />
              </div>
              {/* TruncatedText, not a bare truncate: a long name has to clip with its
                  full value on hover, never push the version and the menu out of the row. */}
              <TruncatedText text={name} readOnly className="min-w-0 flex-1 text-sm font-medium" />
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* Shown before any click: a database ships its Parquet (MIMIC-IV demo
                    is 18 MB), and starting that download unannounced is a surprise on a
                    metered connection. Entries that declare no size show nothing. */}
                {entry.sizeBytes != null && entry.sizeBytes > 0 && (
                  <Badge variant="outline" className="font-mono">
                    {humanBytes(entry.sizeBytes, i18n.language)}
                  </Badge>
                )}
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
                <TruncatedText text={description} readOnly className="text-xs text-muted-foreground" />
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
              // A workspace installs at instance level, so it needs no target and
              // must stay enabled even when no workspace is selected (or exists).
              hasWorkspace={hasWorkspace || entry.type === 'workspace'}
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
      className="h-6 shrink-0 gap-1 whitespace-nowrap px-2 text-xs"
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
