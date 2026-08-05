import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDate } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useUserDirectoryStore, toDetails } from '@/stores/user-directory-store'
import { useAppStore } from '@/stores/app-store'
import { useOrganizationStore } from '@/stores/organization-store'
import type { AuthorDetails } from '@/types/author'
import type { OrganizationInfo } from '@/types'

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
  /** Extra leading content on the meta row (e.g. a per-card stat like "3 projects"). */
  leading?: React.ReactNode
  /** Extra content pinned to the right of the meta row (e.g. a card action button). */
  trailing?: React.ReactNode
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
  label, details, organization, lang, t,
}: {
  label: string
  details?: AuthorDetails
  organization?: OrganizationInfo
  lang: string
  t: (k: string) => string
}) {
  const name = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar className="size-4">
        <AvatarFallback className="bg-primary text-[8px] font-medium text-primary-foreground">
          {authorInitials(label)}
        </AvatarFallback>
      </Avatar>
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

  if (authorRows.length === 0 && orgRows.length === 0) return name

  return (
    <Tooltip>
      {/* tabIndex so the card is reachable by keyboard: the tooltip holds the only
          links to the author's website / email / ORCID, and a bare <span> never
          takes focus, so the tooltip would never open for a keyboard or
          screen-reader user. */}
      <TooltipTrigger asChild>
        <span tabIndex={0} className="min-w-0 cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{name}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <div className="col-span-2 font-semibold">{label}</div>
          {authorRows}
          {orgRows.length > 0 && (
            <div className="col-span-2 mt-1 border-t border-border/50 pt-1.5" />
          )}
          {orgRows}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** A date with a tooltip spelling out whether it's the creation or modification date. */
function DateChip({ date, tooltip }: { date: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 cursor-default">{date}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Shared bottom-of-card meta strip: author (avatar + name), then the creation
 * date and the last-modification date (each with a tooltip saying which is
 * which). Renders nothing when there's nothing to show. Sits below the card body
 * so every harmonized list widget reads the same.
 */
export function CardMetaFooter({ createdById, createdBy, createdByDetails, organizationId, organization, createdAt, updatedAt, leading, trailing, className }: CardMetaFooterProps) {
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
  if (!label && !created && !updated && !leading && !trailing) return null

  // Outer wrapper owns the top gap + optional mt-auto (pin to card bottom); the
  // gap lives in pt-3 so it survives even when mt-auto collapses to 0. Callers
  // drop the card's bottom padding so the bar sits flush at the base — pb-2 here
  // leaves only a small margin below it.
  return (
    // The footer (author/date chips + their tooltips) is provenance UI, not a way
    // to open the card. Swallow clicks so interacting with it — a chip or a link
    // inside its hover tooltip — never triggers the card's onClick navigation.
    <div className={cn('pt-3 pb-2', className)} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 border-t pt-2 text-[11px] text-muted-foreground">
        {leading && <span className="min-w-0 truncate">{leading}</span>}
        {leading && (label || created || updated) && <Sep />}
        {label && (
          <AuthorChip
            label={label}
            details={details}
            organization={org}
            lang={i18n.language}
            t={t}
          />
        )}
        {label && (created || updated) && <Sep />}
        {created && <DateChip date={created} tooltip={t('common.created_on', { date: created })} />}
        {created && updated && <Sep />}
        {updated && <DateChip date={updated} tooltip={t('common.last_modified', { date: updated })} />}
        {/* ml-auto pins the action right; the meta chips above it truncate rather
            than push it off the row. */}
        {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
      </div>
    </div>
  )
}
