import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import { categoryOf, splitLabel } from '@/lib/badge-categories'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { CategoryBadge } from '@/components/ui/category-badge'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { ProjectBadge } from '@/types'

interface BadgeStripProps {
  badges: ProjectBadge[]
  /** Inline text before the badges (e.g. "Linked projects:"), sharing the row. */
  prefix?: string
  className?: string
}

/** A single badge doesn't get to hog the whole row — beyond this it truncates. */
const MAX_BADGE_PX = 128
const GAP_PX = 4 // matches gap-1

const badgeClass =
  'inline-block max-w-32 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium align-top'

/**
 * One-line badge row that adapts to the container width. Every badge is measured
 * at its natural (capped) width; we then keep as many as fit — always reserving
 * room for the grey "+N" chip when any overflow remains — and stop at the first
 * badge that would push past the edge. A too-long single badge truncates with a
 * tooltip; hidden badges are listed (bulleted) in the "+N" chip's tooltip.
 */
export function BadgeStrip({ badges, prefix, className }: BadgeStripProps) {
  const { i18n } = useTranslation()
  const categories = useBadgeCategories()
  const label = (b: ProjectBadge) => localized(b.label, i18n.language)
  /** Two-tone chip for a badge whose prefix names a declared category. */
  const scoped = (b: ProjectBadge) => categoryOf(b, categories, i18n.language)
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(badges.length)

  useLayoutEffect(() => {
    const container = containerRef.current
    const measure = measureRef.current
    if (!container || !measure) return

    const compute = () => {
      // The prefix shares the row, so the badges only get what it leaves.
      const prefixEl = container.querySelector<HTMLElement>('[data-badge-prefix]')
      const avail = container.clientWidth - (prefixEl ? prefixEl.offsetWidth + GAP_PX : 0)
      const spans = Array.from(measure.querySelectorAll<HTMLElement>('[data-measure-badge]'))
      const moreChip = measure.querySelector<HTMLElement>('[data-measure-more]')
      if (spans.length === 0 || avail === 0) return
      const widths = spans.map((s) => Math.min(s.offsetWidth, MAX_BADGE_PX))
      const moreW = moreChip?.offsetWidth ?? 24

      // First, does everything fit with no "+N"?
      let total = 0
      for (let i = 0; i < widths.length; i++) total += widths[i]! + (i > 0 ? GAP_PX : 0)
      if (total <= avail) {
        setVisibleCount(badges.length)
        return
      }

      // Otherwise reserve room for the "+N" chip and count how many badges fit.
      let used = 0
      let count = 0
      for (let i = 0; i < widths.length; i++) {
        const next = used + widths[i]! + (i > 0 ? GAP_PX : 0)
        // Keep this badge only if it fits alongside the eventual "+N" chip.
        if (next + GAP_PX + moreW <= avail) {
          used = next
          count++
        } else break
      }
      setVisibleCount(Math.max(1, count))
    }

    const ro = new ResizeObserver(compute)
    ro.observe(container)
    compute()
    return () => ro.disconnect()
  }, [badges, prefix, categories])

  if (badges.length === 0) return null

  const hidden = badges.slice(visibleCount)

  return (
    <div ref={containerRef} className={cn('relative flex items-center gap-1 overflow-hidden', className)}>
      {prefix && (
        <span data-badge-prefix className="shrink-0 text-[10px] text-muted-foreground">{prefix}</span>
      )}
      {/* Off-screen measurement layer: natural widths, never wraps, not visible. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex gap-1">
        {badges.map((badge) => {
          // A scoped chip is drawn as two padded halves, so it is wider than its
          // text — measure that shape, not the plain one, or the last chip on a
          // tight row would be kept and then overflow.
          const category = scoped(badge)
          return category ? (
            <CategoryBadge
              key={badge.id}
              data-measure-badge
              category={localized(category.name, i18n.language)}
              value={splitLabel(label(badge)).value}
              color={category.color}
              className="max-w-40"
            />
          ) : (
            <span
              key={badge.id}
              data-measure-badge
              className={badgeClass}
              style={getBadgeStyle(badge.color)}
            >
              {label(badge)}
            </span>
          )
        })}
        <span data-measure-more className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium">+{badges.length}</span>
      </div>

      {badges.slice(0, visibleCount).map((badge) => {
        const category = scoped(badge)
        return (
          <Tooltip key={badge.id}>
            <TooltipTrigger asChild>
              {category ? (
                <CategoryBadge
                  category={localized(category.name, i18n.language)}
                  value={splitLabel(label(badge)).value}
                  color={category.color}
                  className="max-w-40"
                />
              ) : (
                <span className={cn(badgeClass, getBadgeClasses(badge.color))} style={getBadgeStyle(badge.color)}>
                  {label(badge)}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">{label(badge)}</TooltipContent>
          </Tooltip>
        )
      })}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-block shrink-0 cursor-default rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              +{hidden.length}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <ul className="list-disc space-y-0.5 pl-3.5">
              {hidden.map((b) => (
                <li key={b.id}>{label(b)}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
