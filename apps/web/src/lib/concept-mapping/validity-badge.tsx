import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'

// OMOP validity is driven by invalid_reason: NULL = valid, 'U' = upgraded (a newer
// concept supersedes it), 'D' = deleted. Abbreviated single-letter badge, mirroring
// StandardConceptBadge — 'V' green for valid, the raw reason letter otherwise.
const INVALID_LABELS: Record<string, string> = {
  U: 'Upgraded',
  D: 'Deleted',
}

export function ValidityBadge({ value }: { value: string | null | undefined }) {
  const isValid = !value
  const badge = isValid ? (
    <Badge variant="default" className="bg-green-600 px-1 py-0.5 text-[8px] leading-none text-white border-transparent hover:bg-green-600">
      V
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1 py-0.5 text-[8px] leading-none text-red-500 border-red-300 dark:border-red-800 dark:text-red-400">
      {value}
    </Badge>
  )

  const label = isValid ? 'Valid' : (INVALID_LABELS[value] ?? `Invalid (${value})`)

  return (
    <div className="flex justify-center">
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}
