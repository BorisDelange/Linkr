import { useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface TruncatedHeaderProps {
  /** The rendered header content (usually a flexRender of the column header). */
  children: ReactNode
  /** Full text for the hover tooltip. Omit for icon-only headers (no tooltip,
   *  no truncation styling — they don't overflow). */
  label?: string
  className?: string
}

/** Resolve a TanStack column header definition to its plain-text label, when it
 *  is one (our headers are `() => t(key)`), else undefined for icon headers.
 *  Pass the result as `label` so the tooltip shows the full text. */
export function headerLabel(header: unknown, ctx: unknown): string | undefined {
  const value = typeof header === 'function' ? (header as (c: unknown) => unknown)(ctx) : header
  return typeof value === 'string' ? value : undefined
}

/**
 * Column-header label that truncates to its column width (ellipsis) instead of
 * overflowing into the neighbouring column, with the full text in a styled hover
 * tooltip shown only when actually cut off. Drop-in for the `<span
 * className="truncate">{flexRender(header)}</span>` every datatable repeats.
 *
 * The parent must bound the width: give the sort button `w-full overflow-hidden`
 * and the `<TableHead>` `overflow-hidden` + `style={{ width, maxWidth }}`.
 */
export function TruncatedHeader({ children, label, className }: TruncatedHeaderProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  // Icon-only header: render as-is, no truncation/tooltip.
  if (label == null) return <span className={cn('shrink-0', className)}>{children}</span>

  const check = () => {
    const el = ref.current
    if (el) setTruncated(el.scrollWidth > el.clientWidth)
  }

  const span = (
    <span ref={ref} onPointerEnter={check} className={cn('block min-w-0 flex-1 truncate text-left', className)}>
      {children}
    </span>
  )

  if (!truncated) return span

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{span}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-pre-wrap">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
