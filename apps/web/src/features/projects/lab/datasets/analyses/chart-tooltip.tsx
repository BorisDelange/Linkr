// The recharts tooltip card (`TOOLTIP_STYLE`) as plain HTML, for custom tooltip
// contents and for charts drawn outside recharts (box plot, ranked list), so
// every chart's hover reads the same.

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TOOLTIP_STYLE } from '@/lib/plugins/shared-styles'

export interface ChartTooltipRow {
  label?: ReactNode
  value: ReactNode
  /** Series colour, drawn as a swatch before the label. */
  color?: string
  /** Secondary figure after the value, e.g. a share "(12.5 %)". */
  note?: ReactNode
}

/**
 * `color` marks the title with the series swatch — a tooltip about one series
 * or category. Several series in one tooltip put their swatch on each row.
 */
export function ChartTooltipCard({ title, color, rows }: { title?: ReactNode; color?: string; rows: ChartTooltipRow[] }) {
  const hasSwatch = rows.some((r) => r.color)
  return (
    <div style={{ ...TOOLTIP_STYLE.contentStyle, lineHeight: 1.5, maxWidth: 320 }}>
      {title != null && title !== '' && (
        <div className="flex items-center gap-1.5" style={{ ...TOOLTIP_STYLE.labelStyle, overflowWrap: 'anywhere' }}>
          {color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
          <span>{title}</span>
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 tabular-nums" style={TOOLTIP_STYLE.itemStyle}>
          {/* A row without a swatch keeps its place, so the labels stay aligned. */}
          {hasSwatch && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: r.color ?? 'transparent' }} />}
          <span>
            {r.label != null && <>{r.label} : </>}
            {r.value}
            {r.note != null && <span className="ml-2">{r.note}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

const CURSOR_OFFSET = 12
const VIEWPORT_MARGIN = 8

/**
 * A tooltip that follows the pointer, for charts recharts does not draw.
 * Portalled with fixed positioning: a dashboard widget clips its overflow, and
 * a tooltip inside it would be cut at the card edge. Flips to the other side of
 * the cursor when it would leave the viewport.
 */
export function FloatingChartTooltip({ point, children }: { point: { x: number; y: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  // Placed imperatively, before paint: the flip needs the card's measured size,
  // and a state round-trip would draw it once in the wrong place.
  useLayoutEffect(() => {
    const el = ref.current
    if (!point || !el) return
    const { width, height } = el.getBoundingClientRect()
    let left = point.x + CURSOR_OFFSET
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) left = point.x - width - CURSOR_OFFSET
    let top = point.y + CURSOR_OFFSET
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = point.y - height - CURSOR_OFFSET
    el.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`
    el.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`
  }, [point, children])

  if (!point) return null
  return createPortal(
    <div ref={ref} className="pointer-events-none fixed left-0 top-0 z-50">
      {children}
    </div>,
    document.body,
  )
}
