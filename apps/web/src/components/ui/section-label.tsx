import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Uppercase group heading inside panels and sidebars. One class string, because
 * this rule existed in 22 spellings — 45 of which differed only in class order.
 *
 * `as` keeps the semantics where the label really is a heading: styling it like
 * one is not the same as being one, and screen readers navigate by the tag.
 */
export function SectionLabel({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'span' | 'p' | 'h2' | 'h3' | 'h4'
}) {
  return (
    <Tag
      className={cn(
        'text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      {children}
    </Tag>
  )
}
