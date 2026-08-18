import { useTranslation } from 'react-i18next'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Marks SQL that the user has edited by hand. Shown on the tab that holds the
 * code, so the state is visible without opening it.
 *
 * The tooltip carries the consequence, not just the fact: editing the config
 * regenerates the query and discards the edit, which is the part worth warning
 * about before it happens.
 */
export function CustomSqlDot({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`size-1.5 shrink-0 rounded-full bg-amber-500 ${className ?? ''}`}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-60">
          {t('cohorts.sql_modified_hint')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
