import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { sanitizeHtml } from '@/lib/sanitize'
import { withResponsiveSvg } from '@/lib/svg-responsive'

const MIN_SCALE = 0.2
const MAX_SCALE = 8
// Zoom per unit of wheel delta, applied exponentially so a pinch (many small
// deltas) and a mouse notch (one large delta) both feel proportionate.
const WHEEL_ZOOM_RATE = 0.002
const PINCH_ZOOM_RATE = 0.01

/** Safari's trackpad pinch: non-standard, so not in the DOM typings. */
interface GestureEvent extends UIEvent {
  scale: number
}

/** Renders a figure (inline SVG or data-image) that fills the available output
 *  area by default, and is zoomable (wheel / buttons) and pannable (drag). The SVG
 *  is normalised to 100% width/height so it scales with the panel on resize. */
export function FigureViewer({ content, label }: { content: string; label?: string }) {
  const { t } = useTranslation()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(scale)
  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  const isSvg = /^\s*(<\?xml|<svg)/.test(content)
  const isImage = content.startsWith('data:image')

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE))
  }, [])

  // Native, non-passive listeners: React registers wheel as passive, so its
  // preventDefault is ignored and a trackpad pinch (Chrome/Firefox: wheel with
  // ctrlKey; Safari: gesture events) zooms the whole page instead of the figure.
  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rate = e.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE
      setScale((s) => clamp(s * Math.exp(-e.deltaY * rate), MIN_SCALE, MAX_SCALE))
    }
    let gestureStartScale = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureStartScale = scaleRef.current
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      setScale(clamp(gestureStartScale * (e as GestureEvent).scale, MIN_SCALE, MAX_SCALE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }, [offset])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    setOffset({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y })
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-white dark:invert dark:hue-rotate-180">
      <div
        ref={surfaceRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        // The browser's own image drag (the translucent ghost) would take over the
        // pointer and stop the pan; panning is ours alone.
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={reset}
      >
        <div
          className="flex h-full w-full items-center justify-center p-4"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: 'center center' }}
        >
          {isSvg ? (
            // Fill the area: force the SVG to 100%/100% and let it keep its ratio.
            <div
              className="flex h-full w-full items-center justify-center [&_svg]:h-full [&_svg]:w-full [&_svg]:max-h-full [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(withResponsiveSvg(content)) }}
            />
          ) : isImage ? (
            <img src={content} alt={label} draggable={false} className="max-h-full max-w-full object-contain" />
          ) : (
            <p className="text-xs text-muted-foreground">{content || 'Figure'}</p>
          )}
        </div>
      </div>

      {/* Zoom controls — non-inverted layer so they read correctly in dark mode. */}
      <div className="absolute bottom-2 right-2 flex gap-1 dark:invert dark:hue-rotate-180">
        <ZoomButton label={t('files.zoom_out')} onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={13} /></ZoomButton>
        <ZoomButton label={t('files.zoom_reset')} onClick={reset}><Maximize2 size={13} /></ZoomButton>
        <ZoomButton label={t('files.zoom_in')} onClick={() => zoomBy(1.25)}><ZoomIn size={13} /></ZoomButton>
      </div>
    </div>
  )
}

function ZoomButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className="rounded border bg-background/90 p-1 text-muted-foreground shadow-sm hover:text-foreground"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
