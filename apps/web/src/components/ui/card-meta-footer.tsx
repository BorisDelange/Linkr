import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDate } from '@/lib/format-helpers'
import { cn } from '@/lib/utils'
import { useUserDirectoryStore } from '@/stores/user-directory-store'
import type { AuthorDetails } from '@/types/author'

interface CardMetaFooterProps {
  /** Stable creator id — resolved to the *current* display name when known. */
  createdById?: number
  /** Display-name snapshot; fallback when the id can't be resolved. */
  createdBy?: string
  createdByDetails?: AuthorDetails
  createdAt?: string
  updatedAt?: string
  /** Extra leading content on the meta row (e.g. a per-card stat like "3 projects"). */
  leading?: React.ReactNode
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
export function CardMetaFooter({ createdById, createdBy, createdByDetails, createdAt, updatedAt, leading, className }: CardMetaFooterProps) {
  const { t, i18n } = useTranslation()
  // Prefer the live directory name (reflects profile renames); fall back to the
  // snapshot taken at creation when the id can't be resolved (author gone / import).
  const resolved = useUserDirectoryStore((s) => (createdById != null ? s.resolveName(createdById) : ''))
  const label = resolved || authorLabel(createdBy, createdByDetails)
  const created = createdAt ? formatDate(createdAt, i18n.language) : ''
  const updated = updatedAt ? formatDate(updatedAt, i18n.language) : ''
  if (!label && !created && !updated && !leading) return null

  // Outer wrapper owns the top gap + optional mt-auto (pin to card bottom); the
  // gap lives in pt-3 so it survives even when mt-auto collapses to 0. Callers
  // drop the card's bottom padding so the bar sits flush at the base — pb-2 here
  // leaves only a small margin below it.
  return (
    <div className={cn('pt-3 pb-2', className)}>
      <div className="flex items-center gap-2 border-t pt-2 text-[11px] text-muted-foreground">
        {leading && <span className="min-w-0 truncate">{leading}</span>}
        {leading && (label || created || updated) && <Sep />}
        {label && (
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar className="size-4">
              <AvatarFallback className="bg-primary text-[8px] font-medium text-primary-foreground">
                {authorInitials(label)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{label}</span>
          </span>
        )}
        {label && (created || updated) && <Sep />}
        {created && <DateChip date={created} tooltip={t('common.created_on', { date: created })} />}
        {created && updated && <Sep />}
        {updated && <DateChip date={updated} tooltip={t('common.last_modified', { date: updated })} />}
      </div>
    </div>
  )
}
