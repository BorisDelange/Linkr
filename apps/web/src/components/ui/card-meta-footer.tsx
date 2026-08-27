import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDate } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useUserDirectoryStore, toDetails } from '@/stores/user-directory-store'
import { useAppStore } from '@/stores/app-store'
import { useOrganizationStore } from '@/stores/organization-store'
import type { AuthorDetails } from '@/types/author'
import type { EntityLicense, OrganizationInfo } from '@/types'
import { licenseTitle } from '@/lib/licenses'
import { Scale } from 'lucide-react'

interface CardMetaFooterProps {
  /** Stable creator id — resolved to the *current* display name AND details
   *  (affiliation / profession / ORCID) when known. */
  createdById?: number
  /** Display-name snapshot; fallback when the id can't be resolved. */
  createdBy?: string
  /** Frozen author-identity snapshot; fallback when the id can't be resolved. */
  createdByDetails?: AuthorDetails
  /** Stable origin-organization id — resolved live from the org store when known. */
  organizationId?: string
  /** Frozen provenance snapshot of the origin organization; fallback when the id
   *  can't be resolved (author gone / cross-instance import). */
  organization?: OrganizationInfo
  createdAt?: string
  updatedAt?: string
  /** Moves the dates into the author tooltip (below the organization) instead of
   *  the row — for footers whose row is already full (e.g. the catalog cards). */
  datesInAuthorTooltip?: boolean
  /** The entity's license, shown as a chip. Clicking it opens the license view. */
  license?: EntityLicense | null
  /** Shows the "No license" chip even when nothing can be opened — on read-only
   *  cards (catalog entries) the absence of a licence is itself worth stating. */
  showLicenseWhenEmpty?: boolean
  /** Opens the entity's license (tab or dialog). Without it the chip is plain text. */
  onOpenLicense?: () => void
  /** Extra leading content on the meta row (e.g. a per-card stat like "3 projects"). */
  leading?: React.ReactNode
  /** Extra content pinned to the right of the meta row (e.g. a card action button). */
  trailing?: React.ReactNode
  /**
   * One item per line instead of a single dot-separated row.
   *
   * For the About panel of a detail page, where the column is narrow and the
   * three chips would truncate against each other — a stacked list reads as
   * the entity's identity rather than as fine print. List cards keep the row:
   * there the footer is one glanceable line under a title.
   */
  stacked?: boolean
  className?: string
}

function authorLabel(createdBy?: string, details?: AuthorDetails): string {
  const full = [details?.firstName, details?.lastName].filter(Boolean).join(' ')
  return full || createdBy || ''
}

function authorInitials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
  return (label.charAt(0) || '?').toUpperCase()
}

const Sep = () => <span aria-hidden className="text-muted-foreground/50">·</span>

/**
 * One label/value line inside the author hover card. Rendered as two grid cells
 * (label + value) so that a parent `grid grid-cols-[auto_1fr]` aligns every
 * label column to the same width, datatable-style.
 */
function DetailRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          // Stop the click from bubbling to the card underneath (which would open
          // the entity) — the tooltip renders in a portal, but the click is
          // replayed on the trigger's ancestors otherwise.
          onClick={(e) => e.stopPropagation()}
          // The tooltip has an INVERTED background (bg-foreground), so page accent
          // colors read poorly on it. Keep the tooltip's own text color for
          // guaranteed contrast and signal the link with a permanent underline.
          className="min-w-0 break-words font-medium text-background underline underline-offset-2 decoration-background/50 hover:decoration-background"
        >
          {value}
        </a>
      ) : (
        <span className="min-w-0 break-words font-medium">{value}</span>
      )}
    </>
  )
}

/** A web URL for a raw value, or null when it isn't linkable. Accepts a bare
 *  domain (chu-hugo.fr) by defaulting to https://; leaves a full URL as-is. */
export function websiteHref(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  // A plausible domain (has a dot, no spaces) → assume https.
  if (/^[^\s/]+\.[^\s/]+/.test(v)) return `https://${v}`
  return null
}

/** ORCID iD → its orcid.org URL. Accepts a bare 16-digit id or an orcid.org URL.
 *  Any OTHER host is refused (null → the value renders as plain text): the row is
 *  labelled "ORCID", so passing an arbitrary URL through would turn an imported
 *  entity's metadata into an ORCID-labelled link to anywhere. */
export function orcidHref(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  const bare = /^(\d{4}-){3}\d{3}[\dX]$/i
  if (bare.test(v)) return `https://orcid.org/${v}`
  const m = /^https?:\/\/(?:www\.)?orcid\.org\/((?:\d{4}-){3}\d{3}[\dX])$/i.exec(v)
  return m ? `https://orcid.org/${m[1]}` : null
}

/**
 * Author name + avatar. On hover, a rich card spells out the author's identity
 * (affiliation / profession / ORCID) and the frozen origin-organization snapshot
 * (name / type / location / country / website / reference id) — the provenance
 * that travels with an exported entity. Without any detail to show, the name is
 * rendered plainly (no tooltip).
 */
function AuthorChip({
  label, details, organization, dates, lang, t, showAvatar = true,
}: {
  label: string
  details?: AuthorDetails
  organization?: OrganizationInfo
  /** Creation / modification dates, when the row has no space for them. */
  dates?: { created: string; updated: string }
  lang: string
  t: (k: string) => string
  /** The initials bubble earns its place on a list card, where it marks the
   *  author at a glance among many. Beside an "Author" label it says nothing
   *  the name doesn't. */
  showAvatar?: boolean
}) {
  const name = (
    <span className="flex min-w-0 items-center gap-1.5">
      {showAvatar && (
        <Avatar className="size-4">
          <AvatarFallback className="bg-primary text-[8px] font-medium text-primary-foreground">
            {authorInitials(label)}
          </AvatarFallback>
        </Avatar>
      )}
      <span className="truncate">{label}</span>
    </span>
  )

  const authorRows: React.ReactNode[] = []
  const affiliation = localized(details?.affiliation, lang)
  const profession = localized(details?.profession, lang)
  if (affiliation) authorRows.push(<DetailRow key="aff" label={t('common.affiliation')} value={affiliation} />)
  if (profession) authorRows.push(<DetailRow key="prof" label={t('common.profession')} value={profession} />)
  if (details?.email) authorRows.push(<DetailRow key="email" label={t('common.email')} value={details.email} href={`mailto:${details.email}`} />)
  if (details?.orcid) authorRows.push(<DetailRow key="orcid" label="ORCID" value={details.orcid} href={orcidHref(details.orcid) ?? undefined} />)

  const orgRows: React.ReactNode[] = []
  if (organization) {
    const orgName = localized(organization.name, lang)
    if (orgName) orgRows.push(<DetailRow key="oname" label={t('common.organization')} value={orgName} />)
    if (organization.type) {
      const orgType = organization.type === 'other' && organization.customType
        ? localized(organization.customType, lang)
        : t(`workspaces.org_type_${organization.type}`)
      orgRows.push(<DetailRow key="otype" label={t('common.type')} value={orgType} />)
    }
    const loc = [localized(organization.location, lang), localized(organization.country, lang)].filter(Boolean).join(', ')
    if (loc) orgRows.push(<DetailRow key="oloc" label={t('common.location')} value={loc} />)
    if (organization.website) orgRows.push(<DetailRow key="oweb" label={t('common.website')} value={organization.website} href={websiteHref(organization.website) ?? undefined} />)
    if (organization.email) orgRows.push(<DetailRow key="oemail" label={t('common.email')} value={organization.email} href={`mailto:${organization.email}`} />)
    if (organization.referenceId) orgRows.push(<DetailRow key="oref" label={t('common.reference_id')} value={organization.referenceId} />)
  }

  const dateRows: React.ReactNode[] = []
  if (dates?.created) dateRows.push(<DetailRow key="created" label={t('common.created')} value={dates.created} />)
  if (dates?.updated) dateRows.push(<DetailRow key="updated" label={t('common.modified')} value={dates.updated} />)

  if (authorRows.length === 0 && orgRows.length === 0 && dateRows.length === 0) return name

  return (
    <Tooltip>
      {/* tabIndex so the card is reachable by keyboard: the tooltip holds the only
          links to the author's website / email / ORCID, and a bare <span> never
          takes focus, so the tooltip would never open for a keyboard or
          screen-reader user. */}
      <TooltipTrigger asChild>
        {/* `shrink`, not just `min-w-0`: this chip and the licence one are the
            two that may give ground when the row is narrower than its content.
            Without it the author name holds its full width and the row — and
            with it the card — refuses to go below that. */}
        <span tabIndex={0} className="min-w-0 shrink cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{name}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <div className="col-span-2 font-semibold">{label}</div>
          {authorRows}
          {orgRows.length > 0 && (
            <div className="col-span-2 mt-1 border-t border-border/50 pt-1.5" />
          )}
          {orgRows}
          {dateRows.length > 0 && (
            <div className="col-span-2 mt-1 border-t border-border/50 pt-1.5" />
          )}
          {dateRows}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The last-modification date, with both dates spelled out on hover. Only one is
 * shown on the row: two bare dates side by side said nothing about which was
 * which, and the row has to leave room for the license.
 */
function DateChip({ created, updated, t }: { created: string; updated: string; t: (k: string, o?: Record<string, unknown>) => string }) {
  const shown = updated || created
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="shrink-0 cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{shown}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {created && <DetailRow label={t('common.created')} value={created} />}
          {updated && <DetailRow label={t('common.modified')} value={updated} />}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** The entity's license, or an invitation to pick one. Clickable when the caller
 *  knows how to open the license view. */
function LicenseChip({
  license, onOpen, t,
}: {
  license?: EntityLicense | null
  onOpen?: () => void
  t: (k: string) => string
}) {
  const title = license ? licenseTitle(license, t('license.custom')) : t('license.none_short')
  const body = (
    <span className={cn('flex w-full min-w-0 items-center gap-1', !license && 'italic')}>
      <Scale size={11} className="shrink-0" />
      <span className="truncate">{title}</span>
    </span>
  )
  // The full title in the tooltip: this is the row's longest label, so it is the
  // first to be truncated when the footer also carries an action button.
  const hint = license
    ? `${title}${onOpen ? ` — ${t('license.open')}` : ''}`
    // Without a licence: an invitation when the viewer can add one, a plain
    // statement of the fact when they can't (a catalog entry isn't theirs to edit).
    : onOpen
      ? t('license.choose')
      : t('license.none_hint')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="flex min-w-0 shrink rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </button>
        ) : (
          <span tabIndex={0} className="flex min-w-0 shrink cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Shared bottom-of-card meta strip: author (avatar + name), then the creation
 * date and the last-modification date (each with a tooltip saying which is
 * which). Renders nothing when there's nothing to show. Sits below the card body
 * so every harmonized list widget reads the same.
 */
export function CardMetaFooter({ createdById, createdBy, createdByDetails, organizationId, organization, createdAt, updatedAt, datesInAuthorTooltip, license, onOpenLicense, showLicenseWhenEmpty, leading, trailing, stacked, className }: CardMetaFooterProps) {
  const { t, i18n } = useTranslation()
  // Prefer the live directory name + details (reflects profile edits); fall back to
  // the snapshot taken at creation when the id can't be resolved (author gone /
  // import). Select only STABLE store references here (the raw directory row and the
  // current user) — deriving AuthorDetails inside the selector would return a fresh
  // object each render and loop the render (Maximum update depth). Derive below with
  // useMemo instead. Subscribing to `me` also re-renders the author's OWN cards after
  // they edit their profile (a change the directory store wouldn't reflect).
  const me = useAppStore((s) => (createdById != null && s.user?.id === createdById ? s.user : null))
  const dirUser = useUserDirectoryStore((s) => (createdById != null ? s.byId[createdById] : undefined))
  const resolved = useUserDirectoryStore((s) => (createdById != null ? s.resolveName(createdById) : ''))
  const resolvedDetails = useMemo(() => {
    const src = me ?? dirUser
    return src ? toDetails(src) : undefined
  }, [me, dirUser])
  const details = resolvedDetails ?? createdByDetails
  // Same asymmetry-killer for the origin org: resolve it live by id (reflects org
  // edits), fall back to the frozen snapshot for cross-instance imports.
  const liveOrg = useOrganizationStore((s) => (organizationId ? s.getOrganization(organizationId) : undefined))
  const org = liveOrg ?? organization
  const label = resolved || authorLabel(createdBy, details)
  const created = createdAt ? formatDate(createdAt, i18n.language) : ''
  const updated = updatedAt ? formatDate(updatedAt, i18n.language) : ''
  const showLicense = !!license || !!onOpenLicense || !!showLicenseWhenEmpty
  const showDatesOnRow = !datesInAuthorTooltip && (created || updated)
  if (!label && !created && !updated && !showLicense && !leading && !trailing) return null

  // Outer wrapper owns the top gap + optional mt-auto (pin to card bottom); the
  // gap lives in pt-3 so it survives even when mt-auto collapses to 0. Callers
  // drop the card's bottom padding so the bar sits flush at the base — pb-2 here
  // leaves only a small margin below it.
  return (
    // The footer (author/date chips + their tooltips) is provenance UI, not a way
    // to open the card. Swallow clicks so interacting with it — a chip or a link
    // inside its hover tooltip — never triggers the card's onClick navigation.
    <div className={cn('pt-3 pb-2', className)} onClick={(e) => e.stopPropagation()}>
      {/* One provider for the whole row: 200ms before the first chip opens (matching
          the clipped title in TruncatedHeader, so the card behaves consistently),
          then sliding between chips is instant. Leave the row for longer than
          skipDelayDuration and the dwell is required again. */}
      <TooltipProvider delayDuration={200} skipDelayDuration={500}>
        {/* `min-w-0`: a flex row's default min-width is its content, so in a
            narrow card (the About panel of a detail page, one third of the
            grid) the author + date + licence chips set a floor the card cannot
            go below and it widens past its column. The chips already truncate
            individually; this lets them. */}
        {stacked ? (
          // A labelled list, one field per line. `auto` on the label track sizes
          // every label to the widest one, so the values line up in a column
          // instead of starting at a different offset on each row.
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-2 text-[11px] text-muted-foreground">
            {leading && <div className="col-span-2 min-w-0 truncate">{leading}</div>}
            {label && (
              <>
                <span>{t('authoring.author')}</span>
                {/* Values in foreground, labels muted: on a detail card these
                    are facts worth reading, not the fine print they are in a
                    list card's single footer row. */}
                <span className="min-w-0 text-foreground">
                  <AuthorChip
                    label={label}
                    details={details}
                    organization={org}
                    dates={datesInAuthorTooltip ? { created, updated } : undefined}
                    lang={i18n.language}
                    t={t}
                    showAvatar={false}
                  />
                </span>
              </>
            )}
            {/* Created and Modified get a line each here, rather than the row's
                single chip that shows one and hides the other in a tooltip. */}
            {created && (
              <>
                <span>{t('common.created')}</span>
                <span className="min-w-0 truncate text-foreground">{created}</span>
              </>
            )}
            {updated && (
              <>
                <span>{t('common.modified')}</span>
                <span className="min-w-0 truncate text-foreground">{updated}</span>
              </>
            )}
            {showLicense && (
              <>
                <span>{t('license.title')}</span>
                <span className="min-w-0 text-foreground">
                  <LicenseChip license={license} onOpen={onOpenLicense} t={t} />
                </span>
              </>
            )}
            {trailing && <div className="col-span-2">{trailing}</div>}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2 border-t pt-2 text-[11px] text-muted-foreground">
            {leading && <span className="min-w-0 truncate">{leading}</span>}
            {leading && (label || created || updated) && <Sep />}
            {label && (
              <AuthorChip
                label={label}
                details={details}
                organization={org}
                dates={datesInAuthorTooltip ? { created, updated } : undefined}
                lang={i18n.language}
                t={t}
              />
            )}
            {label && showDatesOnRow && <Sep />}
            {showDatesOnRow && <DateChip created={created} updated={updated} t={t} />}
            {(label || showDatesOnRow) && showLicense && <Sep />}
            {showLicense && <LicenseChip license={license} onOpen={onOpenLicense} t={t} />}
            {/* ml-auto pins the action right; the meta chips above it truncate rather
                than push it off the row. */}
            {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
          </div>
        )}
      </TooltipProvider>
    </div>
  )
}
