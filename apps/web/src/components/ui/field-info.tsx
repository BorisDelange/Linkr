import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface FieldInfoProps {
  /** The explanation, shown on hover. */
  text: string
}

/**
 * The ⓘ that carries a field's explanation, placed inside its `<Label>`.
 *
 * Use this instead of a paragraph under the input: a hint that is always visible
 * competes with the field itself, and every entity dialog already puts this kind
 * of detail behind the icon (see `EntityIdField`).
 */
export function FieldInfo({ text }: FieldInfoProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info size={13} className="text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
