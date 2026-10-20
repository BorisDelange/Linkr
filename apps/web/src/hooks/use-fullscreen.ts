import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The browser Fullscreen API on one element: `ref` goes on the element shown
 * full screen, `portalContainer` to a `PortalContainerProvider` around it — in
 * fullscreen only that element's subtree is drawn, so menus, dialogs and
 * tooltips portaled to the body would be invisible. Esc and the browser's own
 * controls are followed too.
 */
export function useFullscreen<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  // This element, when it is the one shown full screen.
  const [shown, setShown] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const onChange = () => setShown(document.fullscreenElement && document.fullscreenElement === ref.current ? ref.current : null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggle = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else ref.current?.requestFullscreen().catch(() => {})
  }, [])
  return { ref, isFullscreen: shown != null, toggle, portalContainer: shown }
}
