import { useCallback, useState } from 'react'

/**
 * Pixel `preferredSize` for the first pane of an `<Allotment>`, at `fraction` of the
 * split's width.
 *
 * Allotment restores `preferredSize` on sash double-click, but only when it is a
 * NUMBER — a `"40%"` string is silently skipped and the panes are redistributed
 * evenly instead. Converting the fraction to pixels ourselves is what makes the
 * double-click return to the opening split.
 *
 * Returns a ref callback for the split's container and the size, `null` until the
 * container is measured. Render the `<Allotment>` only once the size is known, so the
 * first layout is already the intended one.
 */
export function useSplitPreferredSize(fraction: number) {
  const [width, setWidth] = useState<number | null>(null)

  const containerRef = useCallback((node: HTMLElement | null) => {
    setWidth(node ? node.clientWidth : null)
  }, [])

  return { containerRef, preferredSize: width === null ? null : Math.round(width * fraction) }
}
