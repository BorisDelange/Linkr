import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { niceTicks } from '@/lib/chart-ticks'
import { CategoryAxisLabel } from './chart-axis-helpers'
import { ChartTooltipCard, FloatingChartTooltip } from './chart-tooltip'
import { buildBoxplotGroups, computeBoxplotStats, type BoxplotData } from './plot-builder-box'
import type { CategoryOrder } from './plot-category-order'
import { formatNumericTick, NO_CUSTOM_ORDER, toNumeric, type PlotServerData } from './plot-builder-shared'

/** Boxplot/violin Y-axis tick: ~3 significant digits, grouped thousands, never scientific notation.
 *  Replaces toPrecision(3) which emits "1.62e+3" for values ≥ 1000. */
function formatBoxTick(val: number): string {
  if (!isFinite(val)) return String(val)
  const abs = Math.abs(val)
  // Integers and large magnitudes: drop the fraction; small magnitudes: keep a few sig-figs.
  const maxFrac = abs >= 100 || Number.isInteger(val) ? 0 : abs >= 1 ? 2 : 4
  return val.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: maxFrac })
}

// ---------------------------------------------------------------------------
// Boxplot / Violin sub-component (custom SVG)
// ---------------------------------------------------------------------------

/** Rough width of one 10px glyph in the 600-unit viewBox, for sizing label room. */
const BOX_CHAR_PX = 5.6

function kernelDensity(values: number[], plotMin: number, plotRange: number, nPoints = 50): { val: number; density: number }[] {
  if (values.length < 2) return []
  const sorted = [...values].sort((a, b) => a - b)
  const bw = (sorted[sorted.length - 1] - sorted[0]) / 15 || 1
  const points: { val: number; density: number }[] = []
  for (let i = 0; i < nPoints; i++) {
    const val = plotMin + (plotRange * i) / (nPoints - 1)
    let sum = 0
    for (const v of values) {
      const u = (val - v) / bw
      sum += Math.exp(-0.5 * u * u)
    }
    points.push({ val, density: sum / (values.length * bw * Math.sqrt(2 * Math.PI)) })
  }
  return points
}

function BoxplotChart({
  data,
  colors,
  opacity,
  valueLabel,
  showGrid,
  violin,
  startAtZero = false,
  xLabelMaxLen = 12,
  decimals = 1,
  horizontal = false,
  boxStyle = 'filled',
  showCount = false,
}: {
  data: BoxplotData[]
  colors: string[]
  opacity: number
  /** Title of the value axis (left when vertical, bottom when horizontal). */
  valueLabel: string
  showGrid: boolean
  violin: boolean
  startAtZero?: boolean
  xLabelMaxLen?: number
  decimals?: number
  horizontal?: boolean
  boxStyle?: string
  showCount?: boolean
}) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)

  const axis = useMemo(() => {
    if (data.length === 0) return null
    const allMin = Math.min(...data.map(d => d.stats.min))
    const allMax = Math.max(...data.map(d => d.stats.max))
    // Nice rounded domain + ticks (e.g. 1500, 2000) rather than raw data bounds.
    const scale = niceTicks([allMin, allMax], startAtZero)
    const plotMin = scale ? scale.domain[0] : allMin - 1
    const plotMax = scale ? scale.domain[1] : allMax + 1
    return { plotMin, plotRange: plotMax - plotMin || 1, valueTicks: scale ? scale.ticks : [plotMin, plotMax] }
  }, [data, startAtZero])

  // Hover re-renders on every mouse move; the densities are O(points × values) per group.
  const densities = useMemo(
    () => (violin && axis ? data.map(d => kernelDensity(d.values, axis.plotMin, axis.plotRange)) : null),
    [data, violin, axis],
  )

  if (!axis) return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">{t('datasets.no_data_available')}</div>
  const { plotMin, plotRange, valueTicks } = axis

  const fmt = formatNumericTick(decimals)
  const outline = !violin && boxStyle === 'outline'
  const countSuffix = (d: BoxplotData) => `n = ${d.values.length.toLocaleString()}`

  const width = 600
  const height = 340

  // Horizontal: category names sit left of the plot and are read in full — the margin
  // follows the longest one, and only a name past 40% of the width gets truncated.
  const maxCatLabelW = width * 0.4
  const hSuffix = (d: BoxplotData) => (showCount ? ` · ${countSuffix(d)}` : '')
  const hLabelW = horizontal
    ? Math.min(maxCatLabelW, Math.max(...data.map(d => (d.name.length + hSuffix(d).length) * BOX_CHAR_PX)) + 8)
    : 0
  const hNameMaxLen = (d: BoxplotData) =>
    Math.max(3, Math.floor((maxCatLabelW - 8) / BOX_CHAR_PX) - hSuffix(d).length)

  const marginLeft = horizontal ? Math.round(hLabelW + 12) : 60
  const marginRight = 20
  const marginTop = 10
  const marginBottom = horizontal ? 28 + (valueLabel ? 16 : 0) : 40 + (showCount ? 12 : 0)
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom
  const catSpan = horizontal ? plotH : plotW
  const slot = catSpan / data.length

  // Tighten category-label truncation to the room each one gets. Box/violin labels sit flat under
  // the axis, so allow ~7px per char to leave a gap between neighbours. Full text on hover.
  const effXLabelMaxLen = Math.max(3, Math.min(xLabelMaxLen, Math.floor(slot / 7)))

  /** Pixel position of a value along the value axis. */
  const toV = (val: number) => {
    const frac = (val - plotMin) / plotRange
    return horizontal ? marginLeft + frac * plotW : marginTop + plotH - frac * plotH
  }
  /** (category-axis, value-axis) → (x, y). */
  const P = (c: number, v: number): [number, number] => (horizontal ? [v, c] : [c, v])
  const seg = (c1: number, v1: number, c2: number, v2: number, props: React.SVGProps<SVGLineElement>) => {
    const [x1, y1] = P(c1, v1)
    const [x2, y2] = P(c2, v2)
    return <line x1={x1} y1={y1} x2={x2} y2={y2} {...props} />
  }

  const boxWidth = horizontal
    ? Math.min(40, Math.max(6, slot * (outline ? 0.45 : 0.6)))
    : Math.min(60, Math.max(20, plotW / data.length - 10))

  const hovered = hover ? data[hover.index] : undefined
  const plotBottom = marginTop + plotH

  return (
    <>
    <FloatingChartTooltip point={hover}>
      {hover && hovered && (
        <ChartTooltipCard
          title={hovered.name}
          color={colors[hover.index % colors.length]}
          rows={[
            { label: 'n', value: hovered.values.length.toLocaleString() },
            { label: t('datasets.plot_builder_median'), value: fmt(hovered.stats.median) },
            { label: t('datasets.plot_builder_q1_q3'), value: `${fmt(hovered.stats.q1)} – ${fmt(hovered.stats.q3)}` },
            { label: t('datasets.plot_builder_whiskers'), value: `${fmt(hovered.stats.min)} – ${fmt(hovered.stats.max)}` },
            ...(Number.isFinite(hovered.stats.mean) ? [{ label: t('datasets.plot_builder_mean'), value: fmt(hovered.stats.mean) }] : []),
          ]}
        />
      )}
    </FloatingChartTooltip>
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-full"
      preserveAspectRatio="xMidYMid meet"
      onMouseLeave={() => setHover(null)}
    >
      {showGrid &&
        valueTicks.map((tick, i) => {
          const [x1, y1] = P(horizontal ? marginTop : marginLeft, toV(tick))
          const [x2, y2] = P(horizontal ? plotBottom : width - marginRight, toV(tick))
          return (
            <line key={i} x1={x1} x2={x2} y1={y1} y2={y2} stroke="currentColor" strokeOpacity={0.1} strokeDasharray="3,3" />
          )
        })}

      {horizontal ? (
        <>
          <line x1={marginLeft} x2={width - marginRight} y1={plotBottom} y2={plotBottom} stroke="currentColor" strokeOpacity={0.2} />
          {valueTicks.map((tick, i) => (
            <text key={i} x={toV(tick)} y={plotBottom + 14} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>
              {formatBoxTick(tick)}
            </text>
          ))}
          {valueLabel && (
            <text x={marginLeft + plotW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.7}>
              {valueLabel}
            </text>
          )}
        </>
      ) : (
        <>
          <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={plotBottom} stroke="currentColor" strokeOpacity={0.2} />
          {valueTicks.map((tick, i) => (
            <text key={i} x={marginLeft - 8} y={toV(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.6}>
              {formatBoxTick(tick)}
            </text>
          ))}
          {valueLabel && (
            <text
              x={14}
              y={marginTop + plotH / 2}
              textAnchor="middle"
              fontSize={11}
              fill="currentColor"
              opacity={0.7}
              transform={`rotate(-90, 14, ${marginTop + plotH / 2})`}
            >
              {valueLabel}
            </text>
          )}
        </>
      )}

      {data.map((d, i) => {
        const c = (horizontal ? marginTop : marginLeft) + slot * (i + 0.5)
        const color = colors[i % colors.length]
        const { min, q1, median, q3, max } = d.stats
        // The whole band answers the hover, not just the box: a short box or a
        // thin violin is otherwise a hard target.
        const hitArea = (
          <rect
            x={horizontal ? marginLeft : marginLeft + slot * i}
            y={horizontal ? marginTop + slot * i : marginTop}
            width={horizontal ? plotW : slot}
            height={horizontal ? slot : plotH}
            fill={hover?.index === i ? 'var(--color-muted)' : 'transparent'}
            fillOpacity={0.5}
          />
        )
        const track = (e: React.MouseEvent) => setHover({ index: i, x: e.clientX, y: e.clientY })
        const label = horizontal ? (
          <CategoryAxisLabel
            x={marginLeft - 8}
            y={c + 3}
            textAnchor="end"
            name={d.name}
            maxLen={hNameMaxLen(d)}
            suffix={hSuffix(d) || undefined}
          />
        ) : (
          <>
            <CategoryAxisLabel x={c} y={plotBottom + 20} name={d.name} maxLen={effXLabelMaxLen} />
            {showCount && (
              <text x={c} y={plotBottom + 32} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.45}>
                {countSuffix(d)}
              </text>
            )}
          </>
        )

        if (violin) {
          const density = densities?.[i] ?? []
          if (density.length < 2) return null
          const maxD = Math.max(...density.map(p => p.density))
          const halfW = boxWidth * 0.6
          const pathPoints = density.map(p => ({
            v: toV(p.val),
            dc: maxD > 0 ? (p.density / maxD) * halfW : 0,
          }))
          const leftPath = pathPoints.map(p => P(c - p.dc, p.v).join(',')).join(' ')
          const rightPath = [...pathPoints].reverse().map(p => P(c + p.dc, p.v).join(',')).join(' ')
          return (
            <g key={i} onMouseMove={track}>
              {hitArea}
              <polygon
                points={`${leftPath} ${rightPath}`}
                fill={color}
                fillOpacity={opacity}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.6}
              />
              {seg(c - halfW * 0.4, toV(median), c + halfW * 0.4, toV(median), { stroke: 'white', strokeWidth: 2 })}
              {label}
            </g>
          )
        }

        const halfBox = boxWidth / 2
        const [bx1, by1] = P(c - halfBox, toV(q3))
        const [bx2, by2] = P(c + halfBox, toV(q1))
        const boxRect = { x: Math.min(bx1, bx2), y: Math.min(by1, by2), width: Math.abs(bx2 - bx1), height: Math.abs(by2 - by1) }

        if (outline) {
          // The median is what the eye should compare: a thick line in the series colour
          // pulled toward the foreground (darker on light, lighter on dark), over a faint box.
          const medianTone = `color-mix(in oklab, ${color} 55%, var(--color-foreground))`
          const medianText = fmt(median)
          const capHalf = Math.max(3, halfBox * 0.25)
          // Vertical: value beside the median, in the gap to the next box. Horizontal: just
          // above the median line. Dropped when the gap can't hold it (the tooltip still has it).
          const medianLabelFits = horizontal
            ? (slot - boxWidth) / 2 >= 12
            : slot - boxWidth - 6 >= medianText.length * BOX_CHAR_PX
          const [mx, my] = horizontal ? [toV(median), c - halfBox - 3] : [c + halfBox + 3, toV(median) + 3]
          return (
            <g key={i} onMouseMove={track}>
              {hitArea}
              {seg(c, toV(max), c, toV(q3), { stroke: color, strokeWidth: 1, strokeOpacity: 0.6 })}
              {seg(c, toV(q1), c, toV(min), { stroke: color, strokeWidth: 1, strokeOpacity: 0.6 })}
              {seg(c - capHalf, toV(max), c + capHalf, toV(max), { stroke: color, strokeWidth: 1, strokeOpacity: 0.6 })}
              {seg(c - capHalf, toV(min), c + capHalf, toV(min), { stroke: color, strokeWidth: 1, strokeOpacity: 0.6 })}
              <rect {...boxRect} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1.5} rx={2} />
              {seg(c - halfBox, toV(median), c + halfBox, toV(median), { style: { stroke: medianTone }, strokeWidth: 3, strokeLinecap: 'butt' })}
              {medianLabelFits && (
                <text
                  x={mx}
                  y={my}
                  textAnchor={horizontal ? 'middle' : 'start'}
                  fontSize={10}
                  fontWeight={600}
                  style={{ fill: medianTone }}
                >
                  {medianText}
                </text>
              )}
              {label}
            </g>
          )
        }

        return (
          <g key={i} onMouseMove={track}>
            {hitArea}
            {seg(c, toV(max), c, toV(min), { stroke: color, strokeWidth: 1.5, strokeOpacity: 0.5 })}
            {seg(c - halfBox * 0.4, toV(max), c + halfBox * 0.4, toV(max), { stroke: color, strokeWidth: 1.5 })}
            {seg(c - halfBox * 0.4, toV(min), c + halfBox * 0.4, toV(min), { stroke: color, strokeWidth: 1.5 })}
            <rect
              {...boxRect}
              fill={color}
              fillOpacity={opacity}
              stroke={color}
              strokeWidth={1.5}
              rx={2}
            />
            {seg(c - halfBox, toV(median), c + halfBox, toV(median), { stroke: 'white', strokeWidth: 2 })}
            {label}
          </g>
        )
      })}
    </svg>
    </>
  )
}

// ---------------------------------------------------------------------------
// Boxplot / Violin
// ---------------------------------------------------------------------------

export function BoxViolinPlot({
  rows, catCol, valCol, colors, opacity, valueLabel, showGrid, violin, startAtZero, xLabelMaxLen = 12, decimals = 1,
  horizontal = false, boxStyle = 'filled', categoryOrder = null, categoryOrderCustom = NO_CUSTOM_ORDER, showCount = false, serverData,
}: {
  rows: Record<string, unknown>[]
  /** Category column, or the value column itself when `valCol` is empty (one box). */
  catCol: string
  valCol?: string
  colors: string[]; opacity: number; valueLabel: string; showGrid: boolean; violin: boolean; startAtZero?: boolean; xLabelMaxLen?: number; decimals?: number
  horizontal?: boolean; boxStyle?: string; showCount?: boolean
  categoryOrder?: CategoryOrder | null; categoryOrderCustom?: readonly string[]
  serverData?: PlotServerData | null
}) {
  const data = useMemo<BoxplotData[]>(() => {
    if (serverData) return (serverData.data ?? []) as unknown as BoxplotData[]
    const valueCol = valCol ?? catCol
    const groupCol = valCol ? catCol : null

    if (!groupCol) {
      const values = rows.map(r => toNumeric(r[valueCol])).filter(v => !isNaN(v))
      const stats = computeBoxplotStats(values)
      if (!stats) return []
      return [{ name: valueCol, stats, values }]
    }

    const groups = new Map<string, number[]>()
    for (const row of rows) {
      const cat = String(row[groupCol] ?? '')
      const val = toNumeric(row[valueCol])
      if (isNaN(val)) continue
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(val)
    }
    return buildBoxplotGroups(groups, categoryOrder ?? 'data', categoryOrderCustom)
  }, [serverData, rows, catCol, valCol, categoryOrder, categoryOrderCustom])

  return (
    <div className="w-full h-full">
      <BoxplotChart
        data={data}
        colors={colors}
        opacity={opacity}
        valueLabel={valueLabel}
        showGrid={showGrid}
        violin={violin}
        startAtZero={startAtZero}
        xLabelMaxLen={xLabelMaxLen}
        decimals={decimals}
        horizontal={horizontal}
        boxStyle={boxStyle}
        showCount={showCount}
      />
    </div>
  )
}
