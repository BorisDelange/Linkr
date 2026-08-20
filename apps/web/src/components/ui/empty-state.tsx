import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: LucideIcon
  title: ReactNode
  description?: ReactNode
  /** A create/import button, or a hint on how to fill the collection. */
  action?: ReactNode
  /**
   * `empty` = the collection has nothing in it yet (large icon, full weight).
   * `filtered` = a search or filter matched nothing, which is a smaller,
   * dimmer state so it reads as transient rather than as an empty app.
   */
  variant?: 'empty' | 'filtered'
  className?: string
}

/**
 * "There is nothing here" in one place. The app had this in four text sizes and
 * eight container shapes before; the icon size and dimming carry the difference
 * between an empty collection and a filter that matched nothing.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'empty',
  className,
}: EmptyStateProps) {
  const filtered = variant === 'filtered'
  return (
    <div className={cn('flex flex-col items-center py-12', filtered && 'py-8', className)}>
      {Icon && (
        <Icon
          size={filtered ? 32 : 40}
          className={filtered ? 'text-muted-foreground/30' : 'text-muted-foreground'}
        />
      )}
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
