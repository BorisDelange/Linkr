import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** Hover dwell before a tooltip is built, matching Radix's old delayDuration. */
const HOVER_DELAY_MS = 200

/** How much of the text a tooltip shows. A cell can hold a whole SQL query or
 *  script; shown in full, the tooltip runs off the page. */
const TOOLTIP_MAX_CHARS = 500
const TOOLTIP_MAX_LINES = 12

/** `text` cut to what a tooltip can show, with an ellipsis when it was cut. */
export function clipForTooltip(text: string, maxChars = TOOLTIP_MAX_CHARS, maxLines = TOOLTIP_MAX_LINES): string {
  const lines = text.split('\n')
  let clipped = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  if (clipped.length > maxChars) clipped = clipped.slice(0, maxChars)
  return clipped.length < text.length ? `${clipped.trimEnd()} …` : text
}

interface TruncatedTextProps {
  /** Full text; shown truncated inline and in full inside the tooltip. */
  text: string
  /** Number of lines before clamping. 1 = single-line ellipsis (default). */
  lines?: number
  className?: string
}

/**
 * Render text clamped to `lines`, with the full value in a hover tooltip
 * (default styled: dark background, light text, rounded). Overflow is measured
 * on hover (after layout settles), so the tooltip only appears when the text is
 * actually cut. `block` + width clamp keeps it from widening a flex container.
 *
 * The tooltip only reveals: it carries no copy button and does not take the
 * pointer, so it closes as soon as the pointer leaves and never blocks the rows
 * below it. Copying a table cell goes through its right-click menu
 * (`CellContextMenu`). A very long value (a query, a script) is cut in the
 * tooltip so it stays on the page.
 *
 * Cost note: until the pointer arrives this renders a bare <p> — a table of
 * these is never a table of live tooltips.
 */
export function TruncatedText({ text, lines = 1, className }: TruncatedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [truncated, setTruncated] = useState(false)
  const [hovered, setHovered] = useState(false)

  // Mounting is deferred by the same delay the tooltip used to open with, so
  // sweeping the pointer across a table doesn't mount one per cell passed over.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const check = () => {
    const el = ref.current
    if (!el) return
    setTruncated(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1)
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHovered(true), HOVER_DELAY_MS)
  }

  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }

  const clampClass = lines === 1 ? 'truncate' : 'overflow-hidden'
  const clampStyle =
    lines === 1
      ? undefined
      : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical' as const }

  const content = (
    <p
      ref={ref}
      onPointerEnter={check}
      onPointerLeave={cancelHover}
      className={cn('block min-w-0 max-w-full', clampClass, className)}
      style={clampStyle}
    >
      {text}
    </p>
  )

  if (!hovered || !truncated) return content

  // delayDuration 0: the dwell already elapsed before this mounted, and Radix
  // would otherwise wait for a *second* enter it never saw.
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip defaultOpen onOpenChange={(o) => { if (!o) setHovered(false) }}>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        {/* pointer-events-none: the tooltip floats over the rows below, and a
            hoverable panel there would block clicking them. */}
        <TooltipContent side="top" className="pointer-events-none max-w-xs text-wrap whitespace-pre-wrap break-words">
          {clipForTooltip(text)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
