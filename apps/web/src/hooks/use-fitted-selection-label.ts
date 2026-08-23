import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The label a multi-select trigger shows: the chosen options spelled out while
 * they fit, and a count once they do not.
 *
 * Naming the options is far more useful than counting them — "Mean ± SD,
 * Median [IQR]" says what the widget will do, "2 / 7" does not. But a long list
 * clipped mid-word is worse than either, so the list is measured against the
 * trigger and swapped for a count only when it genuinely overflows.
 *
 * Measuring beats guessing from string length: the trigger's width depends on
 * the panel, which the user can resize, and character widths vary by an order
 * of magnitude between `i` and `M` in a proportional font.
 */
export function useFittedSelectionLabel(labels: string[]) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const [fits, setFits] = useState(true)

  const joined = labels.join(', ')

  useLayoutEffect(() => {
    const container = containerRef.current
    const probe = probeRef.current
    if (!container || !probe) return

    const measure = () => {
      // The probe renders the full list unclipped off-screen; compare its
      // natural width against the space the trigger actually gives us.
      setFits(probe.scrollWidth <= container.clientWidth)
    }
    measure()

    // The panel is resizable, so the answer changes without any state changing.
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [joined])

  return { containerRef, probeRef, joined, fits }
}
