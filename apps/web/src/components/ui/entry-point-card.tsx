import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// Whole class names, so Tailwind's source scan finds them.
const ACCENTS = {
  teal: { gradient: 'from-teal-500/5 to-teal-600/10', square: 'bg-teal-500/10', text: 'text-teal-600' },
  indigo: { gradient: 'from-indigo-500/5 to-indigo-600/10', square: 'bg-indigo-500/10', text: 'text-indigo-600' },
  green: { gradient: 'from-green-500/5 to-green-600/10', square: 'bg-green-500/10', text: 'text-green-600' },
  amber: { gradient: 'from-amber-500/5 to-amber-600/10', square: 'bg-amber-500/10', text: 'text-amber-600' },
} as const

interface EntryPointCardProps {
  icon: LucideIcon
  title: string
  description: string
  /** The call to action at the bottom ("Open…"). */
  openLabel: string
  onClick: () => void
  accent: keyof typeof ACCENTS
  /** Shown as a badge beside the title when above zero. */
  count?: number
}

/**
 * A clickable widget leading to one sub-view of a section landing page
 * (Concept mapping, Vocabularies): tinted icon, title, description, call to action.
 */
export function EntryPointCard({ icon: Icon, title, description, openLabel, onClick, accent, count }: EntryPointCardProps) {
  const colors = ACCENTS[accent]
  return (
    <Card
      className="group relative cursor-pointer overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-lg"
      onClick={onClick}
    >
      <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity group-hover:opacity-100', colors.gradient)} />
      <div className="relative flex flex-col gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', colors.square)}>
            <Icon size={18} className={colors.text} />
          </div>
          <p className="text-sm font-semibold">{title}</p>
          {!!count && (
            <Badge variant="secondary" className="ml-auto shrink-0">
              {count}
            </Badge>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        <div className={cn('flex items-center gap-1 text-xs font-medium', colors.text)}>
          {openLabel}
          <ChevronRight size={13} />
        </div>
      </div>
    </Card>
  )
}
