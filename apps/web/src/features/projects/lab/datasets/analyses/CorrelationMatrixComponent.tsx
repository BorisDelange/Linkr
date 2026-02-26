import { useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Grid3X3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

// ===========================================================================
// Types
// ===========================================================================

interface CorrelationCell {
  r: number
  pValue: number
  n: number
}

interface CorrelationResult {
  names: string[]
  matrix: CorrelationCell[][]
}

// ===========================================================================
// Distribution CDF (t-distribution for p-values)
// ===========================================================================

function gammaLn(x: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x)
  }
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function logBeta(a: number, b: number): number {
  return gammaLn(a) + gammaLn(b) - gammaLn(a + b)
}

function regularizedBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedBeta(b, a, 1 - x)
  }
  const lnPrefix = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b) - Math.log(a)
  const maxIter = 200
  const eps = 1e-14
  let h = 1
  let denom = 1
  let prev = 1
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    denom = 1 + numerator / denom
    if (Math.abs(denom) < 1e-30) denom = 1e-30
    denom = 1 / denom
    prev = 1 + numerator / prev
    if (Math.abs(prev) < 1e-30) prev = 1e-30
    h *= denom * prev

    numerator = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    denom = 1 + numerator / denom
    if (Math.abs(denom) < 1e-30) denom = 1e-30
    denom = 1 / denom
    prev = 1 + numerator / prev
    if (Math.abs(prev) < 1e-30) prev = 1e-30
    const delta = denom * prev
    h *= delta
    if (Math.abs(delta - 1) < eps) break
  }
  return Math.exp(lnPrefix) * h
}

function tCDF(t: number, df: number): number {
  const x = df / (df + t * t)
  const p = 0.5 * regularizedBeta(df / 2, 0.5, x)
  return t >= 0 ? 1 - p : p
}

function correlationPValue(r: number, n: number): number {
  if (n <= 2) return 1
  if (Math.abs(r) >= 1) return 0
  const t = r * Math.sqrt((n - 2) / (1 - r * r))
  const df = n - 2
  return 2 * Math.min(tCDF(t, df), 1 - tCDF(t, df))
}

// ===========================================================================
// Correlation computation
// ===========================================================================

function isNotMissing(v: unknown): boolean {
  return v != null && v !== '' && String(v).toLowerCase() !== 'null'
}

function extractPairwiseNumbers(
  rows: Record<string, unknown>[],
  colA: string,
  colB: string,
): { a: number[]; b: number[] } {
  const a: number[] = []
  const b: number[] = []
  for (const row of rows) {
    const va = row[colA]
    const vb = row[colB]
    if (!isNotMissing(va) || !isNotMissing(vb)) continue
    const na = typeof va === 'number' ? va : Number(va)
    const nb = typeof vb === 'number' ? vb : Number(vb)
    if (isNaN(na) || isNaN(nb)) continue
    a.push(na)
    b.push(nb)
  }
  return { a, b }
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length
  if (n < 2) return NaN
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0
  for (let i = 0; i < n; i++) {
    sumA += a[i]
    sumB += b[i]
    sumAB += a[i] * b[i]
    sumA2 += a[i] * a[i]
    sumB2 += b[i] * b[i]
  }
  const num = n * sumAB - sumA * sumB
  const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB))
  if (den === 0) return NaN
  return num / den
}

function spearmanCorrelation(a: number[], b: number[]): number {
  const n = a.length
  if (n < 2) return NaN
  const rankA = assignRanks(a)
  const rankB = assignRanks(b)
  return pearsonCorrelation(rankA, rankB)
}

function assignRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }))
  indexed.sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank
    i = j
  }
  return ranks
}

function computeCorrelationMatrix(
  rows: Record<string, unknown>[],
  columns: { id: string; name: string; type: string }[],
  selectedIds: string[],
  method: 'pearson' | 'spearman',
): CorrelationResult {
  const colMap = new Map(columns.map(c => [c.id, c]))
  const validCols = selectedIds
    .map(id => colMap.get(id))
    .filter((c): c is { id: string; name: string; type: string } => c != null && c.type === 'number')

  const names = validCols.map(c => c.name)
  const n = validCols.length
  const matrix: CorrelationCell[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => ({ r: 0, pValue: 1, n: 0 })),
  )

  const corrFn = method === 'spearman' ? spearmanCorrelation : pearsonCorrelation

  for (let i = 0; i < n; i++) {
    matrix[i][i] = { r: 1, pValue: 0, n: rows.length }
    for (let j = i + 1; j < n; j++) {
      const { a, b } = extractPairwiseNumbers(rows, validCols[i].id, validCols[j].id)
      const r = corrFn(a, b)
      const pVal = isNaN(r) ? 1 : correlationPValue(r, a.length)
      const cell = { r: isNaN(r) ? 0 : r, pValue: pVal, n: a.length }
      matrix[i][j] = cell
      matrix[j][i] = cell
    }
  }

  return { names, matrix }
}

// ===========================================================================
// Color scale — modern teal ↔ white ↔ orange/coral
// ===========================================================================

function correlationColor(r: number): string {
  const clamped = Math.max(-1, Math.min(1, r))
  const t = Math.abs(clamped)

  if (clamped >= 0) {
    // White → Red (#dc2626 at full)
    const red = Math.round(255 - t * 35)
    const green = Math.round(255 - t * 217)
    const blue = Math.round(255 - t * 217)
    return `rgb(${red}, ${green}, ${blue})`
  } else {
    // White → Blue (#2563eb at full)
    const red = Math.round(255 - t * 218)
    const green = Math.round(255 - t * 156)
    const blue = Math.round(255 - t * 20)
    return `rgb(${red}, ${green}, ${blue})`
  }
}

/** Text color for good contrast on the cell background. */
function cellTextColor(r: number): string {
  return Math.abs(r) > 0.45 ? '#fff' : 'var(--color-foreground)'
}

// ===========================================================================
// Formatting
// ===========================================================================

function fmtR(r: number): string {
  if (!isFinite(r)) return '\u2014'
  return r.toFixed(2)
}

function pStars(p: number): string {
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return ''
}

// ===========================================================================
// Component
// ===========================================================================

export function CorrelationMatrixComponent({ config, columns, rows, compact }: ComponentPluginProps) {
  const { i18n } = useTranslation()
  const lang = (i18n.language === 'fr' ? 'fr' : 'en') as 'en' | 'fr'

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rawSelectedColumns = config.selectedColumns as string[] | undefined
  const method = (config.method as 'pearson' | 'spearman') ?? 'pearson'
  const showValues = (config.showValues as boolean) ?? true
  const showSignificance = (config.showSignificance as boolean) ?? true
  const alpha = (config.alpha as number) ?? 0.05

  const numericCols = columns.filter(c => c.type === 'number')
  const selectedColumns = rawSelectedColumns?.length ? rawSelectedColumns : numericCols.map(c => c.id)

  const result = useMemo(
    () => computeCorrelationMatrix(rows, columns, selectedColumns, method),
    [rows, columns, selectedColumns, method],
  )

  // Empty states
  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Grid3X3 size={24} className="opacity-40" />
        <p className="text-xs">{lang === 'fr' ? 'Aucune donnée disponible.' : 'No data available.'}</p>
      </div>
    )
  }

  if (numericCols.length < 2) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Grid3X3 size={24} className="opacity-40" />
        <p className="text-xs">
          {lang === 'fr'
            ? 'Au moins 2 variables numériques sont nécessaires.'
            : 'At least 2 numeric variables are required.'}
        </p>
      </div>
    )
  }

  if (result.names.length < 2) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Grid3X3 size={24} className="opacity-40" />
        <p className="text-xs">
          {lang === 'fr'
            ? 'Sélectionnez au moins 2 variables numériques.'
            : 'Select at least 2 numeric variables.'}
        </p>
      </div>
    )
  }

  const n = result.names.length
  const pad = compact ? 8 : 16
  const headerLine = compact ? 16 : 20 // method line height
  const footerLine = showSignificance ? (compact ? 14 : 18) : 0
  const legendWidth = compact ? 32 : 44

  // Compute cell size from available space
  const availW = Math.max(200, containerSize.width - pad * 2 - legendWidth - 8)
  const availH = Math.max(200, containerSize.height - pad * 2 - headerLine - footerLine - 4)
  // Reserve space for rotated column headers and row labels
  const labelReserve = compact ? 60 : 80
  const gridSpace = Math.min(availW - labelReserve, availH - labelReserve)
  const cellSize = Math.max(24, Math.floor(gridSpace / n))

  const gridW = n * cellSize
  const gridH = n * cellSize

  // Font sizing based on cell size
  const valueFontSize = Math.max(8, Math.min(compact ? 10 : 12, cellSize * 0.28))
  const starsFontSize = Math.max(7, valueFontSize - 2)
  const labelFontSize = Math.max(8, Math.min(compact ? 9 : 11, cellSize * 0.24))

  // SVG dimensions: labels + grid + legend
  const svgWidth = labelReserve + gridW + legendWidth
  const svgHeight = labelReserve + gridH
  const gridX = labelReserve
  const gridY = labelReserve

  return (
    <div ref={containerRef} className={cn('h-full w-full overflow-hidden flex flex-col', compact ? 'p-2' : 'p-4')}>
      {/* Method header */}
      <div className={cn('mb-1 shrink-0 text-muted-foreground', compact ? 'text-[9px]' : 'text-[11px]')}>
        <span className="font-semibold text-foreground">
          {method === 'pearson' ? 'Pearson' : 'Spearman'}
        </span>
        {' '}{lang === 'fr' ? 'corrélation' : 'correlation'}
        {' '}(n = {rows.length})
      </div>

      {/* Heatmap SVG — fills remaining space */}
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {containerSize.width > 0 && (
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            width={Math.min(containerSize.width - pad * 2, svgWidth)}
            height={Math.min(containerSize.height - pad * 2 - headerLine - footerLine, svgHeight)}
            className="text-foreground"
            style={{ fontSize: labelFontSize }}
          >
            {/* Column headers (rotated, above grid) */}
            {result.names.map((name, j) => {
              const cx = gridX + j * cellSize + cellSize / 2
              return (
                <text
                  key={`col-${j}`}
                  x={cx}
                  y={gridY - 6}
                  textAnchor="start"
                  fill="currentColor"
                  opacity={0.75}
                  fontSize={labelFontSize}
                  transform={`rotate(-50, ${cx}, ${gridY - 6})`}
                >
                  {name.length > 18 ? name.slice(0, 16) + '…' : name}
                </text>
              )
            })}

            {/* Row headers (left of grid) */}
            {result.names.map((name, i) => (
              <text
                key={`row-${i}`}
                x={gridX - 6}
                y={gridY + i * cellSize + cellSize / 2 + valueFontSize * 0.35}
                textAnchor="end"
                fill="currentColor"
                opacity={0.75}
                fontSize={labelFontSize}
              >
                {name.length > 12 ? name.slice(0, 10) + '…' : name}
              </text>
            ))}

            {/* Grid cells */}
            {result.matrix.map((row, i) =>
              row.map((cell, j) => {
                const isDiag = i === j
                const cx = gridX + j * cellSize
                const cy = gridY + i * cellSize
                const isSig = !isDiag && cell.pValue < alpha
                const bgColor = isDiag ? correlationColor(1) : correlationColor(cell.r)
                const txtColor = isDiag ? 'rgba(255,255,255,0.35)' : cellTextColor(cell.r)

                return (
                  <g key={`${i}-${j}`}>
                    <rect
                      x={cx + 0.5}
                      y={cy + 0.5}
                      width={cellSize - 1}
                      height={cellSize - 1}
                      rx={2}
                      fill={bgColor}
                      opacity={isDiag ? 0.35 : 1}
                    />
                    {showValues && (
                      <text
                        x={cx + cellSize / 2}
                        y={cy + cellSize / 2 + (showSignificance && !isDiag && isSig ? -starsFontSize * 0.3 : valueFontSize * 0.35)}
                        textAnchor="middle"
                        fill={txtColor}
                        fontSize={valueFontSize}
                        fontWeight={isSig ? 700 : 400}
                      >
                        {isDiag ? '1' : fmtR(cell.r)}
                      </text>
                    )}
                    {showSignificance && !isDiag && isSig && (
                      <text
                        x={cx + cellSize / 2}
                        y={cy + cellSize / 2 + valueFontSize * 0.35 + starsFontSize * 0.7}
                        textAnchor="middle"
                        fill={txtColor}
                        fontSize={starsFontSize}
                        opacity={0.7}
                      >
                        {pStars(cell.pValue)}
                      </text>
                    )}
                  </g>
                )
              }),
            )}

            {/* Color legend (vertical bar, right of grid) */}
            {(() => {
              const lx = gridX + gridW + 8
              const ly = gridY
              const lh = gridH
              const lw = compact ? 8 : 12
              const steps = 40
              return (
                <g>
                  {Array.from({ length: steps }, (_, i) => {
                    const r = 1 - (i / (steps - 1)) * 2
                    const sy = ly + (i / steps) * lh
                    return (
                      <rect key={i} x={lx} y={sy} width={lw} height={lh / steps + 0.5} rx={i === 0 ? 2 : i === steps - 1 ? 2 : 0} fill={correlationColor(r)} />
                    )
                  })}
                  <text x={lx + lw + 3} y={ly + labelFontSize * 0.4} fill="currentColor" opacity={0.5} fontSize={labelFontSize * 0.85}>+1</text>
                  <text x={lx + lw + 3} y={ly + lh / 2 + labelFontSize * 0.2} fill="currentColor" opacity={0.5} fontSize={labelFontSize * 0.85}>0</text>
                  <text x={lx + lw + 3} y={ly + lh} fill="currentColor" opacity={0.5} fontSize={labelFontSize * 0.85}>-1</text>
                </g>
              )
            })()}
          </svg>
        )}
      </div>

      {/* Significance footer */}
      {showSignificance && (
        <div className={cn('shrink-0 mt-1 text-muted-foreground', compact ? 'text-[8px]' : 'text-[10px]')}>
          * p &lt; 0.05 &nbsp; ** p &lt; 0.01 &nbsp; *** p &lt; 0.001
        </div>
      )}
    </div>
  )
}
