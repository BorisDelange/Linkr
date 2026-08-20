import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Buttons on the title row, right-aligned (create, import, …). */
  actions?: ReactNode
  /** Rendered above the title — typically a back link. */
  above?: ReactNode
  className?: string
}

/**
 * The title block every page shares. Extracted from ListPageTemplate, which 20
 * other pages were copying by hand; use it so the page title stays one decision
 * rather than one per screen.
 */
export function PageHeader({ title, description, actions, above, className }: PageHeaderProps) {
  return (
    <div className={className}>
      {above && <div className="mb-1">{above}</div>}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  )
}

/** Width and padding of a standard page's content column. */
export function PageContainer({
  children,
  width = '4xl',
  className,
}: {
  children: ReactNode
  width?: '3xl' | '4xl' | '5xl'
  className?: string
}) {
  return (
    <div className="h-full overflow-auto">
      <div
        className={cn(
          'mx-auto px-6 py-10',
          width === '3xl' && 'max-w-3xl',
          width === '4xl' && 'max-w-4xl',
          width === '5xl' && 'max-w-5xl',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
