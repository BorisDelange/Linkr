import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { changeTypeMeta } from './git-change-meta'

/** Coloured A/M/D/R square for a git change type, with a dark tooltip naming it. */
export function ChangeBadge({ changeType }: { changeType: string }) {
  const { t } = useTranslation()
  const meta = changeTypeMeta(changeType)
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold',
              meta.badgeClass,
            )}
          >
            {meta.letter}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{t(meta.labelKey)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
