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
  const config = TYPE_CONFIG[type] ?? TYPE_CONFIG.unknown

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded font-mono font-semibold leading-none shrink-0',
        config.color,
        size === 'sm' ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]',
      )}
    >
      {config.icon}
      {showLabel && <span className="font-sans font-medium ml-0.5">{config.label}</span>}
    </span>
  )
}
