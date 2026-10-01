import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The grid every entity-card list renders into. Columns are not tied to
 * breakpoints: it fits as many ≥20rem columns as its own width allows, so the
 * same grid gives 2 columns on a laptop, 4 on a wide screen, and adapts inside
 * a dialog or next to a sidebar without a per-call-site override.
 */
export function CardGrid({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))] gap-3', className)}
      {...props}
    />
  )
}
