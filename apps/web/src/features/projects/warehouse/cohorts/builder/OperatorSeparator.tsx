import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { CriteriaOperator } from '@/types'

interface OperatorSeparatorProps {
  operator: CriteriaOperator
  onToggle: () => void
}

export function OperatorSeparator({ operator, onToggle }: OperatorSeparatorProps) {
  const { t } = useTranslation()
  const isAnd = operator === 'AND'

  return (
    <div className="flex items-center justify-center py-1">
      <div className={cn(
        'h-px flex-1',
        isAnd ? 'bg-blue-500/20' : 'bg-orange-500/20',
      )} />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'mx-2 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors select-none',
          isAnd
            ? 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 dark:text-blue-400'
            : 'bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 dark:text-orange-400',
        )}
        title={t('cohorts.toggle_operator')}
      >
        {operator}
      </button>
      <div className={cn(
        'h-px flex-1',
        isAnd ? 'bg-blue-500/20' : 'bg-orange-500/20',
      )} />
    </div>
  )
}
