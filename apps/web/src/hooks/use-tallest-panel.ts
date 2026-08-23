import { useEffect, useRef, useState } from 'react'

/**
 * Keeps a tabbed container as tall as the tallest panel it has rendered, so
 * switching tabs never moves the triggers out from under the pointer.
 *
 * Grow-only, and measured rather than pre-computed: a panel's height isn't known
 * until it mounts, and it can grow afterwards (a badge added, an error shown),
 * which the ResizeObserver picks up. The floor resets when the dialog unmounts.
 *
 * Spread `panelProps` on the element wrapping the active panel, and `containerProps`
 * on its parent.
 */
export function useTallestPanel() {
  const panelRef = useRef<HTMLDivElement>(null)
  const [minHeight, setMinHeight] = useState(0)

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setMinHeight((prev) => Math.max(prev, el.getBoundingClientRect().height))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return {
    containerProps: { style: { minHeight: minHeight || undefined } },
    panelProps: { ref: panelRef },
  }
}
