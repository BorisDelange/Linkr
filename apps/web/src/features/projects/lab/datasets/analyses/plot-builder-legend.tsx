

// ---------------------------------------------------------------------------
// Legend position helper
// ---------------------------------------------------------------------------

export function buildLegendProps(position: string, fontSize = 11): Record<string, unknown> {
  // Bounded, scrollable wrapper so a long legend (e.g. many group×fill combos) stays small and
  // never crushes the plot: side legends cap their width, stacked ones cap their height.
  const vertical = { fontSize, lineHeight: 1.3, maxWidth: '42%', maxHeight: '100%', overflowY: 'auto' as const, overflowX: 'hidden' as const }
  const horizontal = { fontSize, lineHeight: 1.3, maxHeight: '32%', overflowY: 'auto' as const }
  // Recharts paints legend text in the series colour; a light series then
  // vanishes on a light card. The swatch carries the colour, the text stays legible.
  const formatter = (value: unknown) => <span style={{ color: 'var(--color-foreground)' }}>{String(value)}</span>
  switch (position) {
    case 'top-right':
      return { verticalAlign: 'top', align: 'right', layout: 'vertical', wrapperStyle: vertical, formatter }
    case 'top-left':
      return { verticalAlign: 'top', align: 'left', layout: 'vertical', wrapperStyle: vertical, formatter }
    case 'top-center':
      return { verticalAlign: 'top', align: 'center', wrapperStyle: horizontal, formatter }
    default: // 'bottom'
      return { verticalAlign: 'bottom', align: 'center', wrapperStyle: horizontal, formatter }
  }
}
