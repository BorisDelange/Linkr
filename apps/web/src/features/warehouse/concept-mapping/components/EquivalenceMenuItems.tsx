import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EQUIV_BADGE, EQUIVALENCE_OPTIONS } from '@/lib/concept-mapping/equivalence-badge'
import type { MappingEquivalence } from '@/types'

interface EquivalenceMenuItemsProps {
  onPick: (predicate: MappingEquivalence) => void
  /** Menus nested inside a clickable row need the click kept local. */
  stopPropagation?: boolean
}

/** The SKOS equivalence choices, rendered as coloured badges. Shared by every
 *  equivalence picker so they stay visually identical. */
export function EquivalenceMenuItems({ onPick, stopPropagation }: EquivalenceMenuItemsProps) {
  return (
    <>
      {EQUIVALENCE_OPTIONS.map((pred) => (
        <DropdownMenuItem
          key={pred}
          onClick={(e) => { if (stopPropagation) e.stopPropagation(); onPick(pred) }}
        >
          <span className={`inline-flex w-full items-center justify-center rounded px-2 py-1 text-[11px] font-medium ${EQUIV_BADGE[pred].className}`}>
            {EQUIV_BADGE[pred].label}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

interface EquivalencePickerButtonProps {
  value: MappingEquivalence
  onPick: (predicate: MappingEquivalence) => void
  /** Compact variant for dense toolbars/tables. */
  compact?: boolean
  disabled?: boolean
  stopPropagation?: boolean
  className?: string
}

/** Single button showing the current equivalence as a coloured badge, opening the
 *  badge menu. The chevron inherits the badge colour via `text-current`, which the
 *  button's own `[&_svg]` colour rule would otherwise override. */
export function EquivalencePickerButton({
  value, onPick, compact, disabled, stopPropagation, className = '',
}: EquivalencePickerButtonProps) {
  const badge = EQUIV_BADGE[value]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
          className={`${compact ? 'h-6 gap-1 px-2 text-[10px]' : 'h-7 gap-1.5 px-2.5 text-[11px]'} font-medium ${badge?.className ?? ''} ${className}`}
        >
          {badge?.label ?? value}
          <ChevronDown className={compact ? 'size-2.5 text-current' : 'size-3 text-current'} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-0">
        <EquivalenceMenuItems onPick={onPick} stopPropagation={stopPropagation} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
