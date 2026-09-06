/**
 * Full-screen image viewer with zoom and pan.
 *
 * Two entry points, sharing one viewer:
 * - `ImageLightbox` — the dialog itself, for a caller that already owns the
 *   open state (a figure with its own enlarge button).
 * - `ZoomableImage` — a plain `<img>` that opens the viewer when clicked, which
 *   is what every markdown renderer passes as its `img` component.
 */

import { useCallback, useRef, useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25
const ZOOM_WHEEL_STEP = 0.15

interface ImageLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The image's caption, used as the accessible dialog title. */
  label?: string
  /** Rendered inside the pan/zoom surface — an `<img>`, or an inlined SVG. */
  children: React.ReactNode
}

export function ImageLightbox({ open, onOpenChange, label, children }: ImageLightboxProps) {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })
  const surfaceRef = useRef<HTMLDivElement>(null)

  const clampZoom = useCallback((z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)), [])

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_WHEEL_STEP : -ZOOM_WHEEL_STEP)))
  }, [clampZoom])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    isPanning.current = true
    panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [pan])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return
    setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y })
  }, [])

  const handlePointerUp = useCallback(() => {
    isPanning.current = false
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset on open, so reopening never inherits the previous pan.
        if (next) resetView()
        onOpenChange(next)
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Focus the pan surface, not the first toolbar button. Radix autofocus
        // would land on a tooltip trigger, whose own dismissable layer then eats
        // the first Escape — so the viewer took two presses to close.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          surfaceRef.current?.focus()
        }}
        className="flex h-[98vh] max-h-[98vh] w-[98vw] max-w-[98vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[98vw]"
      >
        <DialogTitle className="sr-only">{label || t('common.image')}</DialogTitle>
        <TooltipProvider delayDuration={300}>
          <div className="flex shrink-0 items-center border-b bg-muted/30 px-3 py-1.5">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
                    disabled={zoom <= ZOOM_MIN}
                    aria-label={t('common.zoom_out')}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
                  >
                    <ZoomOut size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('common.zoom_out')}</TooltipContent>
              </Tooltip>
              <span className="w-8 text-center text-[10px] tabular-nums text-muted-foreground">
                {Math.round(zoom * 100)}%
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
                    disabled={zoom >= ZOOM_MAX}
                    aria-label={t('common.zoom_in')}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
                  >
                    <ZoomIn size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('common.zoom_in')}</TooltipContent>
              </Tooltip>
              <button
                onClick={resetView}
                className="rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('common.reset')}
              </button>
            </div>
            {label && (
              <span className="mx-3 min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
                {label}
              </span>
            )}
            <div className={label ? '' : 'flex-1'} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onOpenChange(false)}
                  aria-label={t('common.close')}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('common.close')}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>

        <div
          ref={surfaceRef}
          tabIndex={-1}
          className="min-h-0 flex-1 cursor-grab select-none overflow-hidden outline-none active:cursor-grabbing"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div
            className="flex h-full w-full items-center justify-center"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
          >
            {children}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * An image that opens full-screen when clicked. This is what every markdown
 * renderer installs as its `img` component, so a screenshot in a README, a
 * project summary or a catalog entry is enlargeable everywhere.
 */
export const ZoomableImage = memo(function ZoomableImage({
  src,
  alt,
  className,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (!src) return null

  return (
    <>
      <img
        {...props}
        src={src}
        alt={alt ?? ''}
        title={alt || t('common.enlarge')}
        onClick={() => setOpen(true)}
        className={`cursor-zoom-in ${className ?? ''}`}
      />
      <ImageLightbox open={open} onOpenChange={setOpen} label={alt}>
        <img
          src={src}
          alt={alt ?? ''}
          className="pointer-events-none max-h-full max-w-full object-contain"
          draggable={false}
        />
      </ImageLightbox>
    </>
  )
})
