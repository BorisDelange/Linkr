import { useEffect, useRef, useState } from 'react'

/** Bounds shared by the dashboard's right-hand sidebars. */
export const SIDEBAR_DEFAULT_WIDTH = 340
const MIN_WIDTH = 260
const MAX_WIDTH = 640

/**
 * The drag edge every resizable sidebar shares.
 *
 * A wide invisible hit area with a hairline inside it: the pointer target has to be
 * forgiving (a 1px edge is missed as often as hit), while the mark under it should
 * stay thin. Hover tints it with the sidebar border colour and a drag turns it
 * primary, so the handle confirms the grab before the panel has moved — the same
 * affordance as the main sidebar's rail, which is where this styling comes from.
 *
 * Put it on the edge the panel is resized FROM, and add `RESIZE_HANDLE_ACTIVE` while
 * dragging.
 */
export const RESIZE_HANDLE_CLASS =
  'group absolute inset-y-0 z-20 w-4 -translate-x-1/2 cursor-col-resize select-none touch-none '
  + 'after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 '
  + 'after:transition-colors hover:after:bg-sidebar-border'

/** Applied on top of RESIZE_HANDLE_CLASS while a drag is in progress. */
export const RESIZE_HANDLE_ACTIVE = 'after:bg-primary hover:after:bg-primary'

/**
 * Width state + drag handlers for a right-anchored sidebar resized from its left edge.
 *
 * Spread `handleProps` onto a strip on that edge styled with `RESIZE_HANDLE_CLASS`,
 * and apply `width` to the sidebar's own style. `resizing` drives the active colour.
 *
 * `maxWidth` is raised by panels holding prose rather than form fields, where
 * the dashboard sidebars' 640px would force an uncomfortably narrow measure.
 * `storageKey` remembers the chosen width across sessions.
 */
export function useResizableSidebar(
  defaultWidth: number = SIDEBAR_DEFAULT_WIDTH,
  maxWidth: number = MAX_WIDTH,
  minWidth: number = MIN_WIDTH,
  storageKey?: string,
) {
  const [width, setWidth] = useState(
    () => readStored(storageKey, minWidth, maxWidth) ?? defaultWidth,
  )
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  // Mirrored so the pointerup handler persists the final width without depending on
  // the render that produced it.
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])

  const handleProps = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startW: width }
      setResizing(true)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!dragRef.current) return
      // Dragging left (smaller clientX) widens the right-anchored sidebar.
      const delta = dragRef.current.startX - e.clientX
      setWidth(Math.max(minWidth, Math.min(maxWidth, dragRef.current.startW + delta)))
    },
    onPointerUp: (e: React.PointerEvent) => {
      dragRef.current = null
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      setResizing(false)
      if (storageKey) {
        // Wrapped: a private window or blocked site data throws, and a sidebar that
        // cannot remember its width should still work.
        try { localStorage.setItem(storageKey, String(widthRef.current)) } catch { /* not persisted */ }
      }
    },
  }

  return { width, handleProps, resizing }
}

function readStored(key: string | undefined, min: number, max: number): number | null {
  if (!key) return null
  try {
    const stored = Number(localStorage.getItem(key))
    if (Number.isFinite(stored) && stored >= min) return Math.min(stored, max)
  } catch { /* no stored preference */ }
  return null
}
