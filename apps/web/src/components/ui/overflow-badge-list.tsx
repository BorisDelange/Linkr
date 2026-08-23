import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Hover dwell before the tooltip opens, matching `TruncatedText`. */
const HOVER_DELAY_MS = 200

export interface OverflowBadgeItem {
  key: string
  label: string
}

interface OverflowBadgeListProps {
  items: OverflowBadgeItem[]
  /** Inline text before the badges (e.g. "Linked projects:"). */
  label?: string
  className?: string
}

/**
 * A row of badges that keeps only the ones that fit and folds the rest into a
 * `+N` pill, listing every item as bullets in a hover tooltip.
 *
 * The alternative — letting the row clip under `overflow-hidden` — cuts the last
 * badge through the middle of a word, which reads as a rendering bug rather than
 * as "there is more". Here the row always ends on a whole badge.
 *
 * How many fit is measured, not guessed: names vary from "ICU" to a full study
 * title, so any fixed count is wrong for one card or the other. All badges are
 * laid out in a hidden probe row, and the visible row takes the longest prefix
 * whose widths (plus the `+N` pill) fit the available space.
 */
export function OverflowBadgeList({ items, label, className }: OverflowBadgeListProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(items.length)
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const measure = useCallback(() => {
    const row = rowRef.current
    const probe = probeRef.current
    if (!row || !probe) return

    // The probe holds one span per badge plus, last, the `+N` pill.
    const widths = Array.from(probe.children).map((el) => (el as HTMLElement).offsetWidth)
    const overflowPill = widths.pop() ?? 0
    // `clientWidth` excludes the label, which sits in the same flex row.
    const labelWidth = (row.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
    const gap = 4
    let available = row.clientWidth - (label ? labelWidth + gap : 0)

    let fits = 0
    for (let i = 0; i < widths.length; i++) {
      const needed = widths[i] + (i > 0 ? gap : 0)
      // Every badge but the last must also leave room for the `+N` pill.
      const reserve = i < widths.length - 1 ? gap + overflowPill : 0
      if (needed + reserve > available) break
      available -= needed
      fits++
    }
    setVisibleCount(fits)
  }, [label])

  // Layout effect: measuring after paint would show a full row for one frame,
  // then visibly drop badges.
  useLayoutEffect(() => {
    measure()
    const row = rowRef.current
    if (!row) return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [measure, items])

  if (items.length === 0) return null

  const hiddenCount = items.length - visibleCount
  const badgeClass = 'shrink-0 whitespace-nowrap px-1.5 py-0'

  const openLater = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHovered(true), HOVER_DELAY_MS)
  }
  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }

  const overflowPill = (
    <Badge
      variant="secondary"
      className={cn(badgeClass, 'cursor-default')}
      onPointerEnter={openLater}
      onPointerLeave={cancelHover}
    >
      +{hiddenCount}
    </Badge>
  )

  return (
    <div ref={rowRef} className={cn('flex items-center gap-1 overflow-hidden', className)}>
      {label && <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>}
      {items.slice(0, visibleCount).map((item) => (
        <Badge key={item.key} variant="secondary" className={badgeClass}>
          {item.label}
        </Badge>
      ))}
      {hiddenCount > 0 &&
        // Mounted on first hover, like `TruncatedText`: a page of cards should not
        // be a page of live Radix tooltips. delayDuration 0 because the dwell has
        // already elapsed by the time this mounts.
        (hovered ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip defaultOpen onOpenChange={(o) => { if (!o) setHovered(false) }}>
              <TooltipTrigger asChild>{overflowPill}</TooltipTrigger>
              <TooltipContent side="top" className="pointer-events-none max-w-xs">
                <ul className="list-inside list-disc space-y-0.5 text-left">
                  {items.map((item) => (
                    <li key={item.key} className="break-words">{item.label}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          overflowPill
        ))}

      {/* Probe: the same badges laid out unconstrained, purely to read their
          widths. `absolute` keeps it out of the flow; `invisible` and `inert`
          keep it out of sight and out of the accessibility tree. */}
      <div
        ref={probeRef}
        aria-hidden
        inert
        className="pointer-events-none invisible absolute flex"
      >
        {items.map((item) => (
          <Badge key={item.key} variant="secondary" className={badgeClass}>{item.label}</Badge>
        ))}
        {/* Widest realistic pill, so the reserved space never falls short. */}
        <Badge variant="secondary" className={badgeClass}>+{items.length}</Badge>
      </div>
    </div>
  )
}
