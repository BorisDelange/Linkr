import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface FieldInfoProps {
  /** The explanation, shown on hover. */
  text: string
  /** Icon size: 13 beside a label, 11 beside a `SectionLabel`. */
  size?: number
}

/**
 * The ⓘ that carries a field's explanation, placed inside its `<Label>`.
 *
 * Use this instead of a paragraph under the input: a hint that is always visible
 * competes with the field itself, and every entity dialog already puts this kind
 * of detail behind the icon (see `EntityIdField`).
 */
export function FieldInfo({ text, size = 13 }: FieldInfoProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info size={size} className="shrink-0 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-line">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
