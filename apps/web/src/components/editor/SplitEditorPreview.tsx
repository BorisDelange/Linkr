import { useCallback, useEffect, useRef, useState } from 'react'

interface SplitEditorPreviewProps {
  /** Left pane: the markdown source. */
  editor: React.ReactNode
  /** Right pane: the rendered result. */
  preview: React.ReactNode
}

/** Percent of the width given to the source pane; the divider moves it. */
const DEFAULT_SPLIT = 50
const MIN_SPLIT = 20
const MAX_SPLIT = 80

/** How long the driving side keeps the lock after its last scroll event. */
const SYNC_RELEASE_MS = 120

/**
 * The source/preview split shared by the README and licence editors: a
 * draggable divider, and the two panes scrolling together.
 *
 * The sync is proportional — the same fraction of each side's scrollable
 * height — rather than pixel-for-pixel, because the panes are never the same
 * height: a markdown heading is one line on the left and a whole block on the
 * right, an image is a path on the left and a picture on the right. Matching
 * pixels would drift further apart the further down you go; matching fractions
 * keeps top, middle and bottom aligned.
 *
 * Hand-rolled rather than Allotment: that one sizes its panes from a measured
 * container height and writes it back as inline styles, which fights a layout
 * whose height comes from its content.
 */
export function SplitEditorPreview({ editor, preview }: SplitEditorPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    // The textarea is `h-full` and scrolls itself, so it — not the wrapper — is
    // what emits scroll events on the left. Fall back to the wrapper for a
    // non-textarea editor.
    const left: HTMLElement | null =
      leftRef.current?.querySelector('textarea') ?? leftRef.current
    const right = rightRef.current
    if (!left || !right) return

    // Which side is currently driving. Without it the panes echo each other —
    // our own scrollTop write fires the other's scroll event, which writes
    // back — and the scrolling turns jerky.
    let lock: HTMLElement | null = null
    let release: ReturnType<typeof setTimeout> | undefined

    const frac = (el: HTMLElement) => {
      const max = el.scrollHeight - el.clientHeight
      return max > 0 ? el.scrollTop / max : 0
    }
    const applyFrac = (el: HTMLElement, f: number) => {
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = f * max
    }
    const sync = (from: HTMLElement, to: HTMLElement) => {
      if (lock && lock !== from) return
      lock = from
      applyFrac(to, frac(from))
      clearTimeout(release)
      release = setTimeout(() => { lock = null }, SYNC_RELEASE_MS)
    }

    const onLeft = () => sync(left, right)
    const onRight = () => sync(right, left)
    left.addEventListener('scroll', onLeft, { passive: true })
    right.addEventListener('scroll', onRight, { passive: true })
    return () => {
      left.removeEventListener('scroll', onLeft)
      right.removeEventListener('scroll', onRight)
      clearTimeout(release)
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const pct = ((e.clientX - rect.left) / rect.width) * 100
    setSplit(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, pct)))
  }, [dragging])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }, [])

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 items-stretch">
      {/* `overflow-hidden`, not `auto`: the textarea inside is `h-full` and
          scrolls itself, so a scrolling wrapper would add a second bar. The
          textarea hides its own bar (`scrollbar-none` at the call site) — one
          bar for the pair, on the right, since they scroll together anyway. */}
      <div ref={leftRef} className="min-w-0 overflow-hidden" style={{ width: `${split}%` }}>
        {editor}
      </div>

      {/* Wider hit area than the 1px line it draws, so the divider is grabbable
          without being visually heavy. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(split)}
        className="relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          className={`pointer-events-none mx-auto h-full w-px transition-colors ${
            dragging ? 'bg-primary' : 'bg-border'
          }`}
        />
      </div>

      <div ref={rightRef} className="min-w-0 overflow-y-auto p-4" style={{ width: `${100 - split}%` }}>
        {preview}
      </div>

      {/* While dragging, swallow pointer events over the panes so the textarea
          doesn't start selecting text mid-drag. */}
      {dragging && <div className="fixed inset-0 z-20 cursor-col-resize" />}
    </div>
  )
}
