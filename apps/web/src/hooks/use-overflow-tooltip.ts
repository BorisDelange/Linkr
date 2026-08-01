import { useRef, useState } from 'react'

/**
 * Shows a tooltip only when a text element is actually clipped by its container.
 * Attach `ref` to the truncated element and spread `triggerProps` onto the row
 * (they measure overflow on pointer enter); render the tooltip content only when
 * `overflows` is true so short names stay tooltip-free.
 */
export function useOverflowTooltip<T extends HTMLElement = HTMLSpanElement>() {
  const ref = useRef<T>(null)
  const [overflows, setOverflows] = useState(false)
  const measure = () => {
    const el = ref.current
    if (el) setOverflows(el.scrollWidth > el.clientWidth)
  }
  return { ref, overflows, triggerProps: { onPointerEnter: measure } }
}
