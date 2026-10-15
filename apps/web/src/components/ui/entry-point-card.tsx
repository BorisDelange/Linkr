import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ENTITY_COLORS, type EntityColorKey } from '@/lib/entity-colors'
import { cn } from '@/lib/utils'

interface EntryPointCardProps {
  icon: LucideIcon
  title: string
  description: string
  /** The call to action at the bottom ("Open…"). */
  openLabel: string
  onClick: () => void
  /** The entity the card leads to: its hue, as on its sidebar item and list-page card. */
  accent: EntityColorKey
  /** Shown as a badge beside the title when above zero. */
  count?: number
}

/**
 * A clickable widget leading to one sub-view of a section landing page
 * (Concept mapping, Vocabularies): tinted icon, title, description, call to action.
 */
export function EntryPointCard({ icon: Icon, title, description, openLabel, onClick, accent, count }: EntryPointCardProps) {
  const colors = ENTITY_COLORS[accent]
  return (
    <Card
      className="group relative cursor-pointer overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-lg"
      onClick={onClick}
    >
      <div className={cn('absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100', colors.bg)} />
      <div className="relative flex flex-col gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', colors.bg)}>
            <Icon size={18} className={colors.icon} />
          </div>
          <p className="text-sm font-semibold">{title}</p>
          {!!count && (
            <Badge variant="secondary" className="ml-auto shrink-0">
              {count}
            </Badge>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        <div className={cn('flex items-center gap-1 text-xs font-medium', colors.icon)}>
          {openLabel}
          <ChevronRight size={13} />
        </div>
      </div>
    </Card>
  )
}
