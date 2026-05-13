import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'

const LABELS: Record<string, { short: string; long: string; cls: string }> = {
  S: {
    short: 'S',
    long: 'Standard',
    cls: 'bg-green-600 text-white border-transparent hover:bg-green-600',
  },
  C: {
    short: 'C',
    long: 'Classification',
    cls: 'bg-secondary text-secondary-foreground border-transparent',
  },
}

export function StandardConceptBadge({ value }: { value: string | null | undefined }) {
  const entry = value ? LABELS[value] : null
  const badge = entry ? (
    <Badge variant="default" className={`px-1 py-0.5 text-[8px] leading-none ${entry.cls}`}>
      {entry.short}
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1 py-0.5 text-[8px] leading-none text-red-500 border-red-300 dark:border-red-800 dark:text-red-400">
      NS
    </Badge>
  )

  const label = entry ? entry.long : 'Non-standard'

  return (
    <div className="flex justify-center">
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground">{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}
