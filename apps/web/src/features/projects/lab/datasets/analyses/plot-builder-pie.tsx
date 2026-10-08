import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { PieLabelRenderProps, TooltipContentProps } from 'recharts'
import { CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { truncateLabel } from './chart-axis-helpers'
import { ChartTooltipCard } from './chart-tooltip'
import type { CategoryOrder } from './plot-category-order'
import { buildCategoricalData, NO_CUSTOM_ORDER, sharePct, type PlotServerData } from './plot-builder-shared'

// ---------------------------------------------------------------------------
// Pie / donut
// ---------------------------------------------------------------------------

const RADIAN = Math.PI / 180
/** Slices thinner than this keep their tooltip but get no outside label: on a
 *  crowded ring those labels would only pile on top of each other. */
const PIE_MIN_LABEL_SHARE = 0.03

/** Average width of an 11px label character, to reserve room for outside labels. */
const PIE_LABEL_CHAR_PX = 6.2

function polarPoint(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(-angle * RADIAN), y: cy + r * Math.sin(-angle * RADIAN) }
}

export function PiePlot({
  rows, xCol, colors, opacity, labelMaxLen, categoryOrder = null, categoryOrderCustom = NO_CUSTOM_ORDER, serverData,
}: {
  rows: Record<string, unknown>[]; xCol: string; colors: string[]; opacity: number; labelMaxLen: number
  categoryOrder?: CategoryOrder | null; categoryOrderCustom?: readonly string[]; serverData?: PlotServerData | null
}) {
  const { t } = useTranslation()
  const data = useMemo(
    () => (serverData
      ? (serverData.data ?? []) as { bin: string; count: number }[]
      : buildCategoricalData(rows, xCol, categoryOrder ?? 'value-desc', categoryOrderCustom)),
    [serverData, rows, xCol, categoryOrder, categoryOrderCustom],
  )
  const total = useMemo(() => data.reduce((s, d) => s + d.count, 0), [data])
  const countLabel = t('datasets.plot_builder_count')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const observerRef = useRef<ResizeObserver | null>(null)
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    observerRef.current = new ResizeObserver(measure)
    observerRef.current.observe(el)
  }, [])

  // A one-colour palette shades that colour from full to light, largest slice first.
  const monochrome = colors.length === 1
  const sliceOpacity = (i: number) => {
    if (!monochrome || data.length < 2) return opacity
    return opacity * (1 - 0.75 * (i / (data.length - 1)))
  }

  const renderLabel = useCallback((props: PieLabelRenderProps) => {
    const { cx, cy, midAngle, innerRadius, outerRadius, percent, index } = props as {
      cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; percent: number; index: number
    }
    const name = String(data[index]?.bin ?? '')
    let sliceLabel = null
    if (percent >= PIE_MIN_LABEL_SHARE) {
      const { x, y } = polarPoint(cx, cy, outerRadius + 14, midAngle)
      // Shift the two-line block so it grows away from the ring at the top and bottom.
      const nameY = y - 4 + 10 * Math.sin(-midAngle * RADIAN)
      sliceLabel = (
        <text x={x} y={nameY} textAnchor={x >= cx ? 'start' : 'end'}>
          <tspan x={x} fontSize={11} fill="var(--color-foreground)">
            {truncateLabel(name, labelMaxLen)}
            <title>{name}</title>
          </tspan>
          <tspan x={x} dy={13} fontSize={10} fill="var(--color-muted-foreground)" className="tabular-nums">
            {(percent * 100).toFixed(1)} %
          </tspan>
        </text>
      )
    }
    // The total rides on the first slice's label: it is the only hook that gets the
    // ring's resolved centre and hole radius (a <Label position="center"> sees the
    // chart's box, not the Pie's radii).
    if (index !== 0) return sliceLabel
    const text = total.toLocaleString()
    // Big enough to anchor the ring, small enough that a long total fits the hole.
    const size = Math.max(12, Math.min(30, innerRadius * 0.45, (innerRadius * 1.5) / (0.6 * text.length)))
    return (
      <g>
        {sliceLabel}
        <text x={cx} y={cy} textAnchor="middle">
          <tspan x={cx} dy={size * 0.15} fontSize={size} fontWeight={700} fill="var(--color-foreground)" className="tabular-nums">{text}</tspan>
          <tspan x={cx} dy={Math.max(12, size * 0.6)} fontSize={Math.max(10, size * 0.4)} fill="var(--color-muted-foreground)">n</tspan>
        </text>
      </g>
    )
  }, [data, labelMaxLen, total])

  const renderLabelLine = useCallback((props: { cx: number; cy: number; midAngle: number; outerRadius: number; percent: number }) => {
    if (props.percent < PIE_MIN_LABEL_SHARE) return <g />
    const a = polarPoint(props.cx, props.cy, props.outerRadius + 3, props.midAngle)
    const b = polarPoint(props.cx, props.cy, props.outerRadius + 10, props.midAngle)
    return <path d={`M${a.x},${a.y}L${b.x},${b.y}`} fill="none" stroke="var(--color-muted-foreground)" strokeOpacity={0.5} strokeWidth={1} />
  }, [])

  const renderTooltip = useCallback(({ active, payload }: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null
    const p = payload[0]
    const value = typeof p.value === 'number' ? p.value : 0
    const fill = p.color || (p.payload as { fill?: string } | undefined)?.fill
    return (
      <ChartTooltipCard
        title={p.name}
        color={fill}
        rows={[{ label: countLabel, value: value.toLocaleString(), note: `(${sharePct(value, total)} %)` }]}
      />
    )
  }, [total, countLabel])

  // The ring gives way to its outside labels: a percentage radius sized on the
  // smaller side clipped the left/right labels of a narrow widget.
  const longestLabel = Math.min(labelMaxLen, Math.max(0, ...data.map(d => String(d.bin).length)))
  const labelRoom = 26 + longestLabel * PIE_LABEL_CHAR_PX
  const outerRadius = size.width > 0
    ? Math.max(24, Math.min(size.height / 2 - 34, size.width / 2 - labelRoom))
    : 0

  if (data.length === 0) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('datasets.no_data_available')}</div>

  return (
    <div ref={containerRef} className="h-full w-full">
    <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height="100%">
      <PieChart margin={{ top: 12, right: 12, bottom: 12, left: 12 }}>
        <Tooltip content={renderTooltip} />
        <Pie
          data={data}
          dataKey="count"
          nameKey="bin"
          innerRadius={outerRadius * 0.72}
          outerRadius={outerRadius}
          startAngle={90}
          endAngle={-270}
          paddingAngle={data.length > 1 ? 1.5 : 0}
          cornerRadius={3}
          stroke="none"
          isAnimationActive={false}
          label={renderLabel}
          labelLine={renderLabelLine}
        >
          {data.map((d, i) => (
            <Cell key={d.bin} fill={monochrome ? colors[0] : colors[i % colors.length]} fillOpacity={sliceOpacity(i)} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
    </div>
  )
}
