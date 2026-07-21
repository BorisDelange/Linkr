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
  const range = max - min || 1
  const pct = (v: number) => `${((v - min) / range) * 100}%`
  const cy = height / 2

  return (
    <svg width="100%" height={height} className="overflow-visible">
      {/* Whisker lines */}
      <line x1={pct(min)} y1={cy} x2={pct(p25)} y2={cy} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      <line x1={pct(p75)} y1={cy} x2={pct(max)} y2={cy} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      {/* Whisker end caps */}
      <line x1={pct(min)} y1={cy - 6} x2={pct(min)} y2={cy + 6} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      <line x1={pct(max)} y1={cy - 6} x2={pct(max)} y2={cy + 6} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      {/* IQR box */}
      <rect
        x={pct(p25)} y={cy - 10} width={`${((p75 - p25) / range) * 100}%`} height={20}
        fill="var(--color-primary)" fillOpacity={0.15} stroke="var(--color-primary)" strokeWidth={1.5} rx={2}
      />
      {/* Median line */}
      <line x1={pct(median)} y1={cy - 10} x2={pct(median)} y2={cy + 10} stroke="var(--color-primary)" strokeWidth={2} />
      {/* Mean dot */}
      {mean !== undefined && (
        <circle cx={pct(mean)} cy={cy} r={3} fill="#fb923c" />
      )}
      {/* Axis labels */}
      <text x={pct(min)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(min)}</text>
      <text x={pct(p25)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(p25)}</text>
      <text x={pct(median)} y={height} textAnchor="middle" fontSize={9} fill="var(--color-primary)">{fmtNum(median)}</text>
      <text x={pct(p75)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(p75)}</text>
      <text x={pct(max)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(max)}</text>
    </svg>
  )
}
