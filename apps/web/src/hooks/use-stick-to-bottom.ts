/**
 * Terminal-style "follow the output" scrolling.
 *
 * Output that keeps growing should stay pinned to the bottom — but only while
 * the reader is actually at the bottom. Scrolling up to read something is a
 * deliberate act, and yanking the view back down on the next chunk makes long
 * output impossible to read. So: pinned by default, released the moment the
 * reader scrolls away from the bottom, re-pinned as soon as they come back.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Is this scroll position close enough to the bottom to count as "at the bottom"?
 *
 * A tolerance is required, not optional: fractional device pixels, zoom levels
 * and sub-pixel layout mean scrollTop + clientHeight rarely equals scrollHeight
 * exactly, so an equality test would drop the pin on content that IS at the
 * bottom. It also lets a reader who is nearly at the bottom stay pinned.
 */
export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  tolerance = 24,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= tolerance
}

export interface StickToBottom<T extends HTMLElement> {
  /**
   * Attach to the element that actually SCROLLS. Inside a Radix ScrollArea that
   * is the viewport, not the root — pinning the root would silently do nothing,
   * since its own scrollTop never moves.
   */
  ref: (el: T | null) => void
  /** Whether new content currently scrolls into view. */
  pinned: boolean
  /** Scroll to the bottom and re-pin — for a "jump to latest" affordance. */
  scrollToBottom: () => void
}

/**
 * Keep `ref`'s element scrolled to the bottom as content grows.
 *
 * Pass every value that makes the content grow in `deps` — for streamed output
 * that means the text itself, not just the number of results: a single result
 * whose body keeps growing would otherwise never scroll.
 */
export function useStickToBottom<T extends HTMLElement>(
  deps: readonly unknown[],
  enabled = true,
): StickToBottom<T> {
  // State, not a ref: the element a ScrollArea scrolls is its viewport, which
  // does not exist on first mount. An effect keyed on [] would subscribe to
  // nothing and never retry — this re-runs when the element actually arrives.
  const [element, setElement] = useState<T | null>(null)
  const [pinned, setPinned] = useState(true)
  // Mirrors `pinned` for the scroll-time path, which must not re-subscribe on
  // every state change.
  const pinnedRef = useRef(true)
  // Set while WE are scrolling, so our own scrollTop write does not read as the
  // user scrolling away and unpin us.
  const selfScrollRef = useRef(false)

  const pinToBottom = useCallback((el: T) => {
    selfScrollRef.current = true
    el.scrollTop = el.scrollHeight
    // Released on the next frame, once the scroll event from the write above
    // has been dispatched.
    return requestAnimationFrame(() => { selfScrollRef.current = false })
  }, [])

  const scrollToBottom = useCallback(() => {
    if (!element) return
    pinToBottom(element)
    pinnedRef.current = true
    setPinned(true)
  }, [element, pinToBottom])

  useEffect(() => {
    if (!element) return
    const onScroll = () => {
      if (selfScrollRef.current) return
      const atBottom = isAtBottom(element.scrollTop, element.scrollHeight, element.clientHeight)
      if (atBottom !== pinnedRef.current) {
        pinnedRef.current = atBottom
        setPinned(atBottom)
      }
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [element])

  // Follow the content. `auto`, never `smooth`: a smooth scroll still animating
  // when the next chunk arrives never reaches the bottom, and it fights a reader
  // trying to scroll away.
  useEffect(() => {
    if (!enabled || !pinnedRef.current || !element) return
    const handle = pinToBottom(element)
    return () => cancelAnimationFrame(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, element, pinToBottom, ...deps])

  return { ref: setElement, pinned, scrollToBottom }
}
