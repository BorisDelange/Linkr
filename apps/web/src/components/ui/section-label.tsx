import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Uppercase group heading inside panels and sidebars. One class string, because
 * this rule existed in 22 spellings — 45 of which differed only in class order.
 */
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}
