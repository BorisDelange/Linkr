// Shared axis helpers for chart-rendering plugins (Plot Builder, Key Indicator):
// label truncation + a styled hover tooltip that reveals the full text, and
// recharts tick components that use them.

/** Truncate long text with an ellipsis. */
export function truncateLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

// ---------------------------------------------------------------------------
// Styled hover tooltip (white text on dark rounded background) — shared singleton.
// SVG <title> only renders the unstyled native tooltip, so we manage our own DOM node.
// ---------------------------------------------------------------------------

let labelTooltipEl: HTMLDivElement | null = null

function getLabelTooltip(): HTMLDivElement {
  if (labelTooltipEl) return labelTooltipEl
  const el = document.createElement('div')
  el.style.cssText = [
    'position:fixed', 'z-index:9999', 'pointer-events:none', 'opacity:0',
    'transition:opacity 80ms', 'background:rgba(0,0,0,.85)', 'color:#fff',
    'font-size:11px', 'line-height:1.4', 'padding:4px 8px', 'border-radius:6px',
    'max-width:280px', 'word-break:break-word', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
  ].join(';')
  document.body.appendChild(el)
  // Safety net: if a tick is removed mid-hover (re-render, resize) the mouseleave may never fire,
  // so hide the tooltip on scroll/blur to avoid a stale fixed element lingering over the page.
  window.addEventListener('scroll', hideLabelTooltip, true)
  window.addEventListener('blur', hideLabelTooltip)
  labelTooltipEl = el
  return el
}

export function showLabelTooltip(text: string, clientX: number, clientY: number) {
  const el = getLabelTooltip()
  el.textContent = text
  el.style.opacity = '1'
  const rect = el.getBoundingClientRect()
  let left = clientX + 12
  if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - 12
  el.style.left = `${Math.max(8, left)}px`
  el.style.top = `${Math.max(8, clientY - rect.height - 10)}px`
}

export function hideLabelTooltip() {
  if (labelTooltipEl) labelTooltipEl.style.opacity = '0'
}

// ---------------------------------------------------------------------------
// Tick components
// ---------------------------------------------------------------------------

/** Custom tick that truncates long labels and shows full text in a styled tooltip on hover.
 *  Defaults suit an X (horizontal) axis; pass dx/dy/textAnchor for a Y (vertical category) axis. */
export function TruncatedTick({ x, y, payload, maxLen = 16, angle = 0, textAnchor = 'middle', fontSize = 9, dx = 0, dy = 12 }: {
  x?: number; y?: number; payload?: { value: string }
  maxLen?: number; angle?: number; textAnchor?: string; fontSize?: number; dx?: number; dy?: number
}) {
  const full = String(payload?.value ?? '')
  const display = truncateLabel(full, maxLen)
  const isTruncated = display !== full
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0} y={0} dx={dx} dy={dy}
        textAnchor={textAnchor}
        fontSize={fontSize}
        fill="currentColor"
        opacity={0.7}
        style={isTruncated ? { cursor: 'default' } : undefined}
        transform={angle ? `rotate(${angle})` : undefined}
        onMouseEnter={isTruncated ? e => showLabelTooltip(full, e.clientX, e.clientY) : undefined}
        onMouseMove={isTruncated ? e => showLabelTooltip(full, e.clientX, e.clientY) : undefined}
        onMouseLeave={isTruncated ? hideLabelTooltip : undefined}
      >
        {display}
      </text>
    </g>
  )
}

/** Numeric-axis tick that formats the value and reveals the full value in a styled tooltip on hover. */
export function TruncatedNumericTick({ x, y, payload, formatter, maxLen = 10 }: {
  x?: number; y?: number; payload?: { value: number | string }
  formatter: (v: number | string) => string; maxLen?: number
}) {
  const formatted = formatter(payload?.value ?? '')
  const display = truncateLabel(formatted, maxLen)
  const isTruncated = display !== formatted
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0} y={0} dy={12}
        textAnchor="middle"
        fontSize={10}
        fill="currentColor"
        opacity={0.7}
        style={isTruncated ? { cursor: 'default' } : undefined}
        onMouseEnter={isTruncated ? e => showLabelTooltip(formatted, e.clientX, e.clientY) : undefined}
        onMouseMove={isTruncated ? e => showLabelTooltip(formatted, e.clientX, e.clientY) : undefined}
        onMouseLeave={isTruncated ? hideLabelTooltip : undefined}
      >
        {display}
      </text>
    </g>
  )
}

/** Plain SVG <text> for hand-drawn (non-recharts) category axes — truncates + styled hover tooltip. */
export function CategoryAxisLabel({ x, y, name, maxLen = 12 }: { x: number; y: number; name: string; maxLen?: number }) {
  const display = truncateLabel(name, maxLen)
  const isTruncated = display !== name
  return (
    <text
      x={x} y={y}
      textAnchor="middle"
      fontSize={10}
      fill="currentColor"
      opacity={0.7}
      style={isTruncated ? { cursor: 'default' } : undefined}
      onMouseEnter={isTruncated ? e => showLabelTooltip(name, e.clientX, e.clientY) : undefined}
      onMouseMove={isTruncated ? e => showLabelTooltip(name, e.clientX, e.clientY) : undefined}
      onMouseLeave={isTruncated ? hideLabelTooltip : undefined}
    >
      {display}
    </text>
  )
}
