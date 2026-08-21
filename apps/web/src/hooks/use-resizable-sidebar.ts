import { useRef, useState } from 'react'

/** Bounds shared by the dashboard's right-hand sidebars. */
export const SIDEBAR_DEFAULT_WIDTH = 340
const MIN_WIDTH = 260
const MAX_WIDTH = 640

/**
 * Width state + drag handlers for a right-anchored sidebar resized from its left edge.
 *
 * Spread `handleProps` onto a thin absolutely-positioned strip on that edge, and
 * apply `width` to the sidebar's own style.
 */
export function useResizableSidebar(defaultWidth: number = SIDEBAR_DEFAULT_WIDTH) {
  const [width, setWidth] = useState(defaultWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const handleProps = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startW: width }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!dragRef.current) return
      // Dragging left (smaller clientX) widens the right-anchored sidebar.
      const delta = dragRef.current.startX - e.clientX
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dragRef.current.startW + delta)))
    },
    onPointerUp: (e: React.PointerEvent) => {
      dragRef.current = null
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    },
  }

  return { width, handleProps }
}
