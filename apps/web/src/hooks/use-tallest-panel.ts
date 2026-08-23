import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Sizes a tabbed container to its tallest panel, so switching tabs never moves
 * the triggers out from under the pointer.
 *
 * Every panel is measured, including the ones not on screen: the caller renders
 * the inactive ones inside a zero-height layer and passes each through
 * `measuredPanelProps(key)`. Measuring only what has been *shown* would still let
 * the dialog grow the first time a taller tab is opened.
 *
 * Heights are tracked per panel rather than as a running maximum, so a panel that
 * shrinks (a badge removed) releases the space instead of pinning the dialog to a
 * height nothing needs any more.
 */
export function useTallestPanel() {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const observers = useRef(new Map<string, ResizeObserver>())

  /** Ref factory for one measured panel. Keyed, since panels mount and unmount. */
  const measuredPanelProps = useCallback((key: string) => ({
    // A callback ref, not a stored one: the element is replaced whenever the tab
    // changes, and an observer bound once would keep watching the detached node.
    ref: (el: HTMLDivElement | null) => {
      observers.current.get(key)?.disconnect()
      if (!el) {
        observers.current.delete(key)
        return
      }
      const measure = () => {
        const h = el.getBoundingClientRect().height
        setHeights((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }))
      }
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      observers.current.set(key, observer)
    },
  }), [])

  useEffect(() => {
    const registry = observers.current
    return () => {
      registry.forEach((o) => o.disconnect())
      registry.clear()
    }
  }, [])

  const tallest = Math.max(0, ...Object.values(heights))

  return {
    containerProps: { style: { minHeight: tallest || undefined } },
    measuredPanelProps,
  }
}
