import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { CopyIconButton } from '@/components/ui/copy-icon-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** Hover dwell before a tooltip is built, matching Radix's old delayDuration. */
const HOVER_DELAY_MS = 200

interface TruncatedTextProps {
  /** Full text; shown truncated inline and in full inside the tooltip. */
  text: string
  /** Number of lines before clamping. 1 = single-line ellipsis (default). */
  lines?: number
  className?: string
  /**
   * Show the tooltip even when the text fits, so its copy button is always
   * reachable. Off by default: the tooltip exists to reveal what is cut off,
   * and a table full of always-on tooltips is noisy to move through.
   */
  alwaysShow?: boolean
  /**
   * Drop the copy button and make the tooltip purely informative (it then closes
   * as soon as the pointer leaves, since there is nothing to reach into it for).
   * For tables where the tooltip only has to reveal what is cut off, and a
   * hoverable panel per cell would get in the way of clicking the next row.
   */
  readOnly?: boolean
}

/**
 * Render text clamped to `lines`, with the full value in a hover tooltip
 * (default styled: dark background, light text, rounded). Overflow is measured
 * on hover (after layout settles), so the tooltip only appears when the text is
 * actually cut. `block` + width clamp keeps it from widening a flex container.
 *
 * By default the tooltip is readable, not just glanceable: its text is
 * selectable and it carries a copy button, so a long concept name can be lifted
 * out of a narrow column. That means it must NOT close the moment the pointer
 * leaves the cell — hovering the tooltip itself keeps it open. Pass `readOnly`
 * where that reachability isn't worth a hoverable panel sitting over the rows
 * below (dense pick-a-row tables).
 *
 * Cost note: until the pointer arrives this renders a bare <p>, in BOTH modes —
 * a table of these is never a table of live tooltips. `alwaysShow` only widens
 * what a hover reveals (the tooltip appears even when the text fits, so its copy
 * button stays reachable); it no longer costs a mounted tooltip per cell.
 */
export function TruncatedText({
  text,
  lines = 1,
  className,
  alwaysShow = false,
  readOnly = false,
}: TruncatedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [truncated, setTruncated] = useState(false)
  // `alwaysShow` used to mount a Tooltip per cell up front. On a 100-row table
  // that is ~1000 live Radix tooltips, re-created on every render — enough to
  // make selecting a row visibly lag. The tooltip is now mounted on first hover
  // in both modes; `alwaysShow` only decides whether it appears when the text
  // is NOT cut, which is a question we can answer at hover time too.
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

  // Nothing to reveal until the pointer arrives, and — outside `alwaysShow` —
  // not even then unless the text is actually cut.
  if (!hovered || (!truncated && !alwaysShow)) return content

  // delayDuration 0: the dwell already elapsed before this mounted, and Radix
  // would otherwise wait for a *second* enter it never saw.
  return (
    <TooltipProvider delayDuration={0}>
      {/* Hoverable content (Radix default) is what lets the pointer travel into
          the tooltip to select or copy without it closing — so unmounting is
          driven by Radix closing it, not by the pointer leaving the text. */}
      <Tooltip defaultOpen onOpenChange={(o) => { if (!o) setHovered(false) }}>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent
          side="top"
          className={cn(
            'max-w-xs text-wrap whitespace-pre-wrap break-words',
            // A read-only tooltip must not swallow the pointer: it floats over
            // the rows below, and a hoverable panel there blocks clicking them.
            readOnly && 'pointer-events-none',
          )}
        >
          {readOnly ? (
            text
          ) : (
            <div className="flex items-start gap-1.5">
              <span className="select-text">{text}</span>
              <CopyIconButton text={text} className="mt-px" />
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
