import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DatasetColumn } from '@/types'
import { TypeBadge } from './TypeBadge'

interface ColumnHeaderProps {
  column: DatasetColumn
  isSelected: boolean
  onClick: () => void
  quickStats?: { count: number; nullPct: number }
  dragAttributes?: Record<string, unknown>
  dragListeners?: Record<string, unknown>
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
        <TypeBadge type={column.type} size="sm" />
        <span className="truncate text-xs font-medium">{column.name}</span>
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
