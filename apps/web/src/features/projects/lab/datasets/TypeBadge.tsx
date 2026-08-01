import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const TYPE_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  number:  { icon: '#',  color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',     label: 'number' },
  string:  { icon: 'Aa', color: 'bg-green-500/15 text-green-700 dark:text-green-400',   label: 'string' },
  boolean: { icon: '⊘',  color: 'bg-purple-500/15 text-purple-700 dark:text-purple-400', label: 'boolean' },
  date:    { icon: '◷',  color: 'bg-orange-500/15 text-orange-700 dark:text-orange-400', label: 'date' },
  unknown: { icon: '?',  color: 'bg-gray-500/15 text-gray-700 dark:text-gray-400',       label: 'unknown' },
}

interface TypeBadgeProps {
  type: string
  size?: 'sm' | 'md'
  showLabel?: boolean
}

export function TypeBadge({ type, size = 'md', showLabel = false }: TypeBadgeProps) {
  const { t } = useTranslation()
  const key = TYPE_CONFIG[type] ? type : 'unknown'
  const config = TYPE_CONFIG[key]
  const label = t(`datasets.type_${key}`)

  return (
    <span
      title={label}
      className={cn(
        // Fixed width so different glyphs (#, Aa, ⊘…) all occupy the same box and
        // the labels after the badge line up in lists.
        'inline-flex items-center justify-center rounded font-mono font-semibold leading-none shrink-0',
        config.color,
        size === 'sm' ? 'py-0.5 text-[9px] min-w-[1.15rem]' : 'py-0.5 text-[10px] min-w-[1.4rem]',
        showLabel && (size === 'sm' ? 'gap-0.5 px-1' : 'gap-0.5 px-1.5'),
      )}
    >
      {config.icon}
      {showLabel && <span className="font-sans font-medium ml-0.5">{label}</span>}
    </span>
  )
}
