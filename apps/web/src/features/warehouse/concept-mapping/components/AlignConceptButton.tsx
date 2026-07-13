import { useRef, useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EQUIV_BADGE } from '@/lib/concept-mapping/equivalence-badge'
import type { MappingEquivalence } from '@/types'

const EQUIVALENCES: MappingEquivalence[] = [
  'skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch',
]

interface AlignConceptButtonProps {
  /** Create the mapping with the chosen equivalence. */
  onAlign: (predicate: MappingEquivalence) => void
  /** Already mapped to this target → show a check instead of the button. */
  alreadyMapped?: boolean
}

/**
 * Split button "Exact ▾" that aligns the current source concept onto a target,
 * with a dropdown to pick the SKOS equivalence. Same UI as the mapping editor's
 * target-panel align control, extracted so the concept-set resolved table can
 * reuse it. The chosen equivalence is local to the button (defaults to exact).
 */
export function AlignConceptButton({ onAlign, alreadyMapped }: AlignConceptButtonProps) {
  const [equivalence, setEquivalence] = useState<MappingEquivalence>('skos:exactMatch')
  const [width, setWidth] = useState<number | undefined>(undefined)
  const groupRef = useRef<HTMLDivElement>(null)

  if (alreadyMapped) {
    return <Check size={13} className="mx-auto text-green-600" />
  }

  return (
    <div className="flex" ref={groupRef}>
      <Button
        variant="outline"
        size="sm"
        className={`h-6 rounded-r-none gap-1 px-2 text-[10px] border-r-0 ${EQUIV_BADGE[equivalence].className}`}
        onClick={(e) => { e.stopPropagation(); onAlign(equivalence) }}
      >
        <Plus size={10} />
        {EQUIV_BADGE[equivalence].label}
      </Button>
      <DropdownMenu onOpenChange={(open) => { if (open) setWidth(groupRef.current?.offsetWidth) }}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-6 rounded-l-none px-1" onClick={(e) => e.stopPropagation()}>
            <ChevronDown size={10} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" style={{ width }} className="min-w-0">
          {EQUIVALENCES.map((pred) => (
            <DropdownMenuItem key={pred} onClick={(e) => { e.stopPropagation(); setEquivalence(pred) }}>
              <span className={`inline-flex w-full items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-medium ${EQUIV_BADGE[pred].className}`}>
                {EQUIV_BADGE[pred].label}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
