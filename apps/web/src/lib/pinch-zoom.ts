// Zoom per unit of wheel delta, applied exponentially so a pinch (many small
// deltas) and a mouse notch (one large delta) both feel proportionate.
const WHEEL_ZOOM_RATE = 0.002
const PINCH_ZOOM_RATE = 0.01

/** Safari's trackpad pinch: non-standard, so not in the DOM typings. */
export interface GestureEvent extends UIEvent {
  scale: number
  clientX?: number
  clientY?: number
}

/** The scale factor a wheel event asks for. Chrome and Firefox report a
 *  trackpad pinch as a wheel event with `ctrlKey`. */
export function wheelZoomFactor(e: WheelEvent): number {
  return Math.exp(-e.deltaY * (e.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE))
}

export function clampScale(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Zoom an element's content with the wheel and the trackpad pinch, and nothing
 * else: the listeners are native and non-passive, since React registers wheel as
 * passive and its preventDefault is then ignored — a pinch would zoom the page.
 * `zoom` receives the factor to apply and the pointer position in the element.
 * Returns the cleanup.
 */
export function bindPinchZoom(
  el: HTMLElement,
  zoom: (factor: number, point: { x: number; y: number }) => void,
): () => void {
  const local = (clientX?: number, clientY?: number) => {
    const rect = el.getBoundingClientRect()
    return clientX === undefined || clientY === undefined
      ? { x: rect.width / 2, y: rect.height / 2 }
      : { x: clientX - rect.left, y: clientY - rect.top }
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    zoom(wheelZoomFactor(e), local(e.clientX, e.clientY))
  }
  // Safari reports the pinch as a cumulative scale since the gesture started.
  let lastGestureScale = 1
  const onGestureStart = (e: Event) => {
    e.preventDefault()
    lastGestureScale = 1
  }
  const onGestureChange = (e: Event) => {
    e.preventDefault()
    const g = e as GestureEvent
    zoom(g.scale / lastGestureScale, local(g.clientX, g.clientY))
    lastGestureScale = g.scale
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('gesturestart', onGestureStart)
  el.addEventListener('gesturechange', onGestureChange)
  return () => {
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('gesturestart', onGestureStart)
    el.removeEventListener('gesturechange', onGestureChange)
  }
}
