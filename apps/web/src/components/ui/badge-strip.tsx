import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import { categoryOf, valueOf } from '@/lib/badge-categories'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { CategoryBadge } from '@/components/ui/category-badge'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { BadgeCategory, ProjectBadge } from '@/types'

interface BadgeStripProps {
  badges: ProjectBadge[]
  /** Inline text before the badges (e.g. "Linked projects:"), sharing the row. */
  prefix?: string
  className?: string
}

/** A single badge doesn't get to hog the whole row — beyond this it truncates.
 *  Must match the rendered caps: `max-w-32` (plain) and `max-w-40` (categorized). */
const MAX_BADGE_PX = 128
const MAX_CATEGORY_BADGE_PX = 160
const GAP_PX = 4 // matches gap-1

const badgeClass =
  'inline-block max-w-32 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium align-top'

/** A badge drawn whole, uncapped — the form a tooltip shows it in. */
function FullBadge({
  badge,
  label,
  value,
  category,
  categoryName,
}: {
  badge: ProjectBadge
  label: string
  value: string
  category: BadgeCategory | undefined
  categoryName: string
}) {
  return category ? (
    <CategoryBadge category={categoryName} value={value} color={category.color} />
  ) : (
    <span className={cn(badgeClass, 'max-w-none', getBadgeClasses(badge.color))} style={getBadgeStyle(badge.color)}>
      {label}
    </span>
  )
}

/**
 * One badge, with a tooltip only when its label is actually clipped.
 *
 * A badge that fits shows its whole label already, so a tooltip repeating it is
 * noise on every hover. Measured on pointer enter rather than on render: the
 * width depends on the container, which the strip resizes as badges come and go.
 *
 * It may shrink below its natural width: the strip always keeps one badge, and
 * in a narrow cell that one must give way to the "+N" chip beside it.
 */
function VisibleBadge({
  badge,
  label,
  value,
  category,
  categoryName,
}: {
  badge: ProjectBadge
  label: string
  value: string
  category: BadgeCategory | undefined
  categoryName: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflows, setOverflows] = useState(false)
  // A categorized chip clips its value half, not itself, so measure that.
  const measure = () => {
    const chip = ref.current
    const el = chip?.querySelector<HTMLElement>('[data-badge-value]') ?? chip
    if (el) setOverflows(el.scrollWidth > el.clientWidth)
  }

  const chip = category ? (
    <CategoryBadge
      ref={ref}
      category={categoryName}
      value={value}
      color={category.color}
      className="min-w-0 max-w-40 shrink"
      onPointerEnter={measure}
    />
  ) : (
    <span
      ref={ref}
      className={cn(badgeClass, 'min-w-0 shrink', getBadgeClasses(badge.color))}
      style={getBadgeStyle(badge.color)}
      onPointerEnter={measure}
    >
      {label}
    </span>
  )

  if (!overflows) return chip

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" variant="card" className="p-2">
        <FullBadge badge={badge} label={label} value={value} category={category} categoryName={categoryName} />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A single badge chip, drawn exactly as the strip draws it — two-tone when its
 * prefix names a declared category, a plain filled chip otherwise.
 *
 * For the places that show one badge outside a card row and would otherwise
 * print the raw `Source::MIMIC-IV` label as text.
 */
export function BadgeChip({ badge, workspaceId }: { badge: ProjectBadge; workspaceId?: string }) {
  const { i18n } = useTranslation()
  const categories = useBadgeCategories(workspaceId)
  const category = categoryOf(badge, categories, i18n.language)

  return (
    <VisibleBadge
      badge={badge}
      label={localized(badge.label, i18n.language)}
      value={valueOf(badge, categories, i18n.language)}
      category={category}
      categoryName={category ? localized(category.name, i18n.language) : ''}
    />
  )
}

/**
 * One-line badge row that adapts to the container width. Every badge is measured
 * at its natural (capped) width; we then keep as many as fit — always reserving
 * room for the grey "+N" chip when any overflow remains — and stop at the first
 * badge that would push past the edge. A too-long single badge truncates with a
 * tooltip; hidden badges are drawn as chips in the "+N" chip's tooltip.
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
      const widths = spans.map((s) => Math.min(
        s.offsetWidth,
        s.hasAttribute('data-category') ? MAX_CATEGORY_BADGE_PX : MAX_BADGE_PX,
      ))
      const moreW = moreChip?.offsetWidth ?? 24

      // First, does everything fit with no "+N"?
      //
      // A row that fills the width to the last pixel puts the final chip flush
      // against the container's edge, which reads as a badge sliced by the card
      // border rather than a full row — so require a gap's worth of slack. The
      // "+N" branch below then keeps one fewer badge and says so explicitly,
      // which is honest where a truncated chip touching the edge is not.
      let total = 0
      for (let i = 0; i < widths.length; i++) total += widths[i]! + (i > 0 ? GAP_PX : 0)
      if (total + GAP_PX <= avail) {
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
              data-category
              category={localized(category.name, i18n.language)}
              value={valueOf(badge, categories, i18n.language)}
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
          <VisibleBadge
            key={badge.id}
            badge={badge}
            label={label(badge)}
            value={valueOf(badge, categories, i18n.language)}
            category={category}
            categoryName={category ? localized(category.name, i18n.language) : ''}
          />
        )
      })}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-block shrink-0 cursor-default rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              +{hidden.length}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" variant="card" className="max-w-80 p-2">
            <div className="flex flex-wrap gap-1">
              {hidden.map((badge) => {
                const category = scoped(badge)
                return (
                  <FullBadge
                    key={badge.id}
                    badge={badge}
                    label={label(badge)}
                    value={valueOf(badge, categories, i18n.language)}
                    category={category}
                    categoryName={category ? localized(category.name, i18n.language) : ''}
                  />
                )
              })}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
