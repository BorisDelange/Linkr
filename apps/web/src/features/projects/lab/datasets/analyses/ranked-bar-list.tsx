import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { truncateLabel } from './chart-axis-helpers'
import { ChartTooltipCard, FloatingChartTooltip } from './chart-tooltip'
import { sharePct } from './plot-builder-shared'

/** Tremor-style ranked list: one row per category, a thin bar on a full-width
 *  track, the count right after the bar end. Rows share the card height between
 *  a minimum and a maximum; past the minimum the list scrolls inside the card. */
export function RankedBarList({
  data, colors, colorByCategory, opacity, labelMaxLen, countLabel,
}: {
  data: { bin: string; count: number }[]; colors: string[]; colorByCategory: boolean
  opacity: number; labelMaxLen: number; countLabel: string
}) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  if (data.length === 0) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('datasets.no_data_available')}</div>
  const max = Math.max(...data.map(d => d.count))
  const total = data.reduce((s, d) => s + d.count, 0)
  // Room after the longest bar for its count, so the label never leaves the card.
  const countChars = Math.max(...data.map(d => d.count.toLocaleString().length))
  const colorOf = (i: number) => (colorByCategory ? colors[i % colors.length] : colors[0])
  const hovered = hover ? data[hover.index] : undefined
  return (
    <>
    <FloatingChartTooltip point={hover}>
      {hover && hovered && (
        <ChartTooltipCard
          title={hovered.bin}
          color={colorOf(hover.index)}
          rows={[
            { label: countLabel, value: hovered.count.toLocaleString() },
            { label: t('datasets.plot_builder_share'), value: `${sharePct(hovered.count, total)} %` },
          ]}
        />
      )}
    </FloatingChartTooltip>
    <div
      onMouseLeave={() => setHover(null)}
      className="grid h-full w-full gap-x-3 overflow-y-auto pt-1.5 pr-1"
      style={{
        gridTemplateColumns: 'max-content minmax(0, 1fr)',
        gridAutoRows: 'minmax(22px, 30px)',
        // `safe` keeps the first rows reachable once the list overflows and scrolls.
        alignContent: 'safe center',
      }}
    >
      {data.map((d, i) => {
        const pct = max > 0 ? (d.count / max) * 100 : 0
        const active = hover?.index === i
        return (
          <div key={d.bin} className="contents" onMouseMove={(e) => setHover({ index: i, x: e.clientX, y: e.clientY })}>
            <span className="self-center truncate text-xs text-foreground">{truncateLabel(d.bin, labelMaxLen)}</span>
            <div className="flex items-center" style={{ paddingRight: `${countChars + 1}ch` }}>
              <div className="relative h-2 w-full rounded-full bg-muted">
                <div
                  className="absolute inset-y-0 left-0 min-w-2 rounded-full transition-opacity"
                  style={{ width: `${pct}%`, backgroundColor: colorOf(i), opacity: active ? Math.min(1, opacity + 0.2) : opacity }}
                />
                <span
                  className="absolute top-1/2 -translate-y-1/2 pl-1.5 text-xs tabular-nums text-muted-foreground"
                  style={{ left: `${pct}%` }}
                >
                  {d.count.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
    </>
  )
}
