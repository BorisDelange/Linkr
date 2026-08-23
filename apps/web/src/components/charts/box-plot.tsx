/**
 * A compact horizontal box-and-whisker plot drawn as inline SVG (no chart lib).
 *
 * Positions are percentages across the [min, max] range, so it scales to any
 * container width. Colors use theme tokens; the mean is an orange dot. Shared by
 * the source-concept detail view and the dataset column stats sidebar.
 */

/** Format a number with reasonable precision (integers grouped, else ≤2 decimals). */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export interface BoxPlotProps {
  min: number
  p25: number
  median: number
  p75: number
  max: number
  mean?: number
  height?: number
}

export function BoxPlot({ min, p25, median, p75, max, mean, height = 40 }: BoxPlotProps) {
  // Fed by two callers with untrusted numeric input (server stats that may be
  // absent → NaN, free-form concept-stat parsing). A NaN quartile would make every
  // pct() "NaN%" and render garbage; bail instead. clamp guards a max < min case.
  if (![min, p25, median, p75, max].every(Number.isFinite)) return null
  const range = max - min || 1
  const clamp = (n: number) => Math.max(0, Math.min(100, n))
  // The plot is inset rather than spanning the full width: min sits at 0% and
  // max at 100%, so their end caps and labels are centred exactly on the edges
  // and lose their outer half to any parent that clips. `overflow-visible` on
  // the SVG cannot save them — an ancestor with overflow-auto still cuts.
  const INSET = 6
  const span = 100 - INSET * 2
  const pct = (v: number) => `${INSET + (clamp(((v - min) / range) * 100) * span) / 100}%`
  const widthPct = (a: number, b: number) =>
    `${(clamp(((b - a) / range) * 100) * span) / 100}%`
  // The axis labels sit BELOW the box, so the drawing surface has to be taller
  // than the box itself — writing them at y = height put their baseline on the
  // bottom edge, where a clipping parent cut them off.
  const LABEL_ROW = 11
  const boxHeight = height
  const cy = boxHeight / 2

  return (
    <svg width="100%" height={boxHeight + LABEL_ROW} className="overflow-visible">
      {/* Whisker lines */}
      <line x1={pct(min)} y1={cy} x2={pct(p25)} y2={cy} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      <line x1={pct(p75)} y1={cy} x2={pct(max)} y2={cy} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      {/* Whisker end caps */}
      <line x1={pct(min)} y1={cy - 6} x2={pct(min)} y2={cy + 6} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      <line x1={pct(max)} y1={cy - 6} x2={pct(max)} y2={cy + 6} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      {/* IQR box */}
      <rect
        x={pct(p25)} y={cy - 10} width={widthPct(p25, p75)} height={20}
        fill="var(--color-primary)" fillOpacity={0.15} stroke="var(--color-primary)" strokeWidth={1.5} rx={2}
      />
      {/* Median line */}
      <line x1={pct(median)} y1={cy - 10} x2={pct(median)} y2={cy + 10} stroke="var(--color-primary)" strokeWidth={2} />
      {/* Mean dot */}
      {mean !== undefined && (
        <circle cx={pct(mean)} cy={cy} r={3} fill="#fb923c" />
      )}
      {/* Axis labels */}
      <text x={pct(min)} y={boxHeight + LABEL_ROW - 2} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(min)}</text>
      <text x={pct(p25)} y={boxHeight + LABEL_ROW - 2} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(p25)}</text>
      <text x={pct(median)} y={boxHeight + LABEL_ROW - 2} textAnchor="middle" fontSize={9} fill="var(--color-primary)">{fmtNum(median)}</text>
      <text x={pct(p75)} y={boxHeight + LABEL_ROW - 2} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(p75)}</text>
      <text x={pct(max)} y={boxHeight + LABEL_ROW - 2} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(max)}</text>
    </svg>
  )
}
