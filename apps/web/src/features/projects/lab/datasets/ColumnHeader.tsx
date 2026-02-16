import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DatasetColumn } from '@/types'

interface ColumnHeaderProps {
  column: DatasetColumn
  isSelected: boolean
  onClick: () => void
  quickStats?: { count: number; nullPct: number }
  dragAttributes?: Record<string, unknown>
  dragListeners?: Record<string, unknown>
}

const TYPE_COLORS: Record<string, string> = {
  number: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  string: 'bg-green-500/15 text-green-700 dark:text-green-400',
  boolean: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  date: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  unknown: 'bg-gray-500/15 text-gray-700 dark:text-gray-400',
}

export function ColumnHeader({
  column,
  isSelected,
  onClick,
  quickStats,
  dragAttributes,
  dragListeners,
}: ColumnHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 cursor-pointer select-none px-1',
        isSelected && 'bg-primary/10'
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-1">
        <span
          className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground"
          {...dragAttributes}
          {...dragListeners}
        >
          <GripVertical size={12} />
        </span>
        <span className="truncate text-xs font-medium">{column.name}</span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
            TYPE_COLORS[column.type] ?? TYPE_COLORS.unknown
          )}
        >
          {column.type}
        </span>
      </div>
      {quickStats && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>{quickStats.count}</span>
          <span>·</span>
          <span>{quickStats.nullPct.toFixed(0)}% null</span>
        </div>
      )}
    </div>
  )
}
