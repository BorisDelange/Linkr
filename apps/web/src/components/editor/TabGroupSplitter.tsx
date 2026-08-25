import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/** Neither group may be squeezed below this share of the bar. */
const MIN_SHARE = 0.15
const MAX_SHARE = 1 - MIN_SHARE
/** Even split until the user drags. */
export const DEFAULT_TAB_SPLIT = 0.5

/**
 * Remembers the split per editor, in memory: it should survive opening and
 * closing tabs (which unmount the divider) without coming back a session later.
 */
const splitByKey = new Map<string, number>()

/**
 * How a tab bar's two groups share its width, and the handle that changes it.
 *
 * `share` is the fraction going to the left (file) group. It is applied as
 * flex-basis on each group, which is what makes the divider draggable at all:
 * with the default `flex: 0 1 auto` the groups size themselves from their
 * content, so the divider drifts every time a tab opens or closes.
 */
export function useTabGroupSplit(key: string) {
  const [share, setShare] = useState(() => splitByKey.get(key) ?? DEFAULT_TAB_SPLIT)

  const set = useCallback((next: number) => {
    const clamped = Math.min(MAX_SHARE, Math.max(MIN_SHARE, next))
    splitByKey.set(key, clamped)
    setShare(clamped)
  }, [key])

  const reset = useCallback(() => {
    splitByKey.delete(key)
    setShare(DEFAULT_TAB_SPLIT)
  }, [key])

  /**
   * The flex shorthand for one group. `bothVisible` is false when the other
   * group is empty — the divider is unmounted then, so the surviving group
   * takes the whole bar instead of keeping a share of it that nothing balances.
   */
  const flexFor = useCallback(
    (side: 'left' | 'right', bothVisible: boolean) => {
      if (!bothVisible) return '1 1 0%'
      return `${side === 'left' ? share : 1 - share} 1 0%`
    },
    [share],
  )

  return { share, setShare: set, reset, flexFor }
}

/**
 * The draggable divider between a tab bar's two groups.
 *
 * Both groups scroll their own overflow, so with many tabs on both sides the
 * only way to see more of one is to take width from the other — which is what
 * this handle does. Double-click restores the even split.
 */
export function TabGroupSplitter({
  onShareChange,
  onReset,
}: {
  onShareChange: (share: number) => void
  onReset: () => void
}) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  // The handle measures against its own parent — the tab bar — so the bar needs
  // no ref of its own at the four call sites.
  const handleRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const bar = handleRef.current?.parentElement
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      if (rect.width <= 0) return
      onShareChange((e.clientX - rect.left) / rect.width)
    }
    const stop = () => setDragging(false)
    // On window, not the handle: the pointer routinely leaves a 1px-wide target
    // mid-drag, and the drag has to keep tracking it.
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging, onShareChange])

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('files.resize_tab_groups')}
      title={t('files.resize_tab_groups')}
      onPointerDown={(e) => { e.preventDefault(); setDragging(true) }}
      onDoubleClick={onReset}
      // A 1px rule is impossible to grab, so the hit area is padding around it
      // while the visible line stays hairline.
      className={cn(
        'group relative shrink-0 cursor-col-resize touch-none self-stretch px-1',
        'flex items-center',
      )}
    >
      <div
        className={cn(
          'h-4 w-px bg-border transition-colors',
          'group-hover:bg-primary/60',
          dragging && 'bg-primary',
        )}
      />
    </div>
  )
}
