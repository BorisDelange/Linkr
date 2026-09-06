import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One click on an arrow. Roughly a tab's width, so a click reveals the next one. */
const SCROLL_STEP = 120

/**
 * A horizontally scrolling tab group and the two arrows that drive it.
 *
 * The group hides its scrollbar (`scrollbar-none`), so without the arrows the
 * tabs past the edge are unreachable on a mouse-only setup. `deps` re-measures
 * when the tab list changes — a ResizeObserver alone misses a tab opening,
 * which changes scrollWidth without resizing the scroller.
 */
export function useTabScroll(deps: unknown[] = []) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const update = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    update()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps])

  const scrollBy = useCallback((dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -SCROLL_STEP : SCROLL_STEP, behavior: 'smooth' })
  }, [])

  // The ref is returned apart from the arrows' props: bundling them makes every
  // read of `scroll.canScroll…` in render look like a ref access to the linter.
  return { scrollRef, arrows: { canScrollLeft, canScrollRight, scrollBy } }
}

export interface TabScroll {
  canScrollLeft: boolean
  canScrollRight: boolean
  scrollBy: (dir: 'left' | 'right') => void
}

export function TabScrollArrow({
  dir,
  scroll,
}: {
  dir: 'left' | 'right'
  scroll: TabScroll
}) {
  const { t } = useTranslation()
  const Icon = dir === 'left' ? ChevronLeft : ChevronRight
  const enabled = dir === 'left' ? scroll.canScrollLeft : scroll.canScrollRight
  const onScroll = scroll.scrollBy
  return (
    <button
      type="button"
      onClick={() => onScroll(dir)}
      disabled={!enabled}
      aria-label={t(dir === 'left' ? 'files.scroll_tabs_left' : 'files.scroll_tabs_right')}
      className={cn(
        'shrink-0 px-0.5 py-1.5 text-muted-foreground transition-colors',
        enabled ? 'hover:bg-accent/50 hover:text-foreground' : 'cursor-default text-muted-foreground/25',
      )}
    >
      <Icon size={12} />
    </button>
  )
}
