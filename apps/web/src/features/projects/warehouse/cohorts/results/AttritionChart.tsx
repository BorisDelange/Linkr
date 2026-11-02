import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { cn } from '@/lib/utils'
import { Tooltip as HoverTip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ChartTooltipCard } from '@/features/projects/lab/datasets/analyses/chart-tooltip'
import type { AttritionStep } from '@/types'

interface AttritionChartProps {
  attrition: AttritionStep[]
  /** What each step's label leaves out (its tables, its concepts), by node id. */
  details?: Record<string, string[]>
}

type AttritionView = 'bars' | 'flowchart'

const BAR_SIZE = 16
const ROW_HEIGHT = 38
const AXIS_WIDTH = 220
/** Characters per line of an axis label: 10px text in AXIS_WIDTH. */
const TICK_CHARS = 38
const TICK_LINES = 2

/** A label on at most `maxLines` lines of `maxChars`, broken between words, the
 *  last line ending in … when the label runs on. */
function wrapLabel(label: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= maxChars) { line = next; continue }
    if (line) lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  const shown = lines.slice(0, maxLines)
  const cut = shown.join(' ').length < label.trim().replace(/\s+/g, ' ').length
  return shown.map((l, i) => {
    const last = i === shown.length - 1
    if (l.length > maxChars || (last && cut)) return `${l.slice(0, maxChars - 1).trimEnd()}…`
    return l
  })
}

function StepTick({ x = 0, y = 0, payload }: { x?: number; y?: number; payload?: { value?: string } }) {
  const lines = wrapLabel(payload?.value ?? '', TICK_CHARS, TICK_LINES)
  const lineHeight = 12
  return (
    <text x={x - 4} y={y} textAnchor="end" fontSize={10} fill="var(--color-muted-foreground)">
      {lines.map((line, i) => (
        <tspan key={i} x={x - 4} dy={i === 0 ? 3 - ((lines.length - 1) * lineHeight) / 2 : lineHeight}>{line}</tspan>
      ))}
    </text>
  )
}

/** A step's label, its detail in a tooltip when it has one, else the full
 *  label when cut. */
function StepLabel({ label, detail, className }: { label: string; detail?: string[]; className?: string }) {
  if (!detail?.length) return <TruncatedText text={label} className={className} />
  return (
    <HoverTip>
      <TooltipTrigger asChild>
        <span className={cn('block truncate', className)}>{label}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm">
        <p className="font-medium">{label}</p>
        {detail.map((line, i) => <p key={i} className="break-words">{line}</p>)}
      </TooltipContent>
    </HoverTip>
  )
}

/** Later steps fade, so the eye follows the funnel down. */
const stepOpacity = (idx: number) => Math.max(0.35, 1 - idx * 0.12)

export function AttritionChart({ attrition, details }: AttritionChartProps) {
  const { t } = useTranslation()
  const [view, setView] = useState<AttritionView>('bars')

  if (attrition.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('cohorts.attrition_empty')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex justify-end">
        <div className="flex items-center rounded-md border p-0.5">
          {(['bars', 'flowchart'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] transition-colors',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`cohorts.attrition_view_${v}`)}
            </button>
          ))}
        </div>
      </div>
      {view === 'bars'
        ? <AttritionBars attrition={attrition} details={details} />
        : <AttritionFlowchart attrition={attrition} details={details} />}
    </div>
  )
}

function AttritionBars({ attrition, details }: AttritionChartProps) {
  const { t } = useTranslation()
  const total = attrition[0]?.count ?? 0

  return (
    <>
      {/* Height follows the step count, so bars keep one thickness however few there are. */}
      <div style={{ height: attrition.length * ROW_HEIGHT + 8 }}>
        {/* The panel sits in an Allotment pane, whose width is only known after
            the first layout pass. Without a floor Recharts measures -1 there and
            warns on every mount. */}
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <BarChart
            data={attrition}
            layout="vertical"
            barSize={BAR_SIZE}
            margin={{ top: 4, right: 20, left: 0, bottom: 4 }}
          >
            <XAxis type="number" domain={[0, total || 'auto']} hide />
            <YAxis
              type="category"
              dataKey="label"
              width={AXIS_WIDTH}
              interval={0}
              tick={<StepTick />}
            />
            <Tooltip
              cursor={{ fill: 'var(--color-accent)' }}
              content={({ active, payload }) => {
                const step = active ? (payload?.[0]?.payload as AttritionStep | undefined) : undefined
                if (!step) return null
                return (
                  <ChartTooltipCard
                    title={step.label}
                    rows={[
                      { label: t('cohorts.attrition_count'), value: step.count.toLocaleString() },
                      ...(details?.[step.nodeId] ?? []).map((line) => ({ value: line })),
                    ]}
                  />
                )
              }}
            />
            <Bar dataKey="count" radius={[0, 3, 3, 0]}>
              {attrition.map((step, idx) => (
                <Cell key={step.nodeId} fill="var(--color-primary)" fillOpacity={stepOpacity(idx)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="space-y-1">
        {attrition.map((step, idx) => (
          <div key={step.nodeId} className="flex items-center gap-2 text-xs">
            <div
              className="size-2.5 shrink-0 rounded-sm bg-primary"
              style={{ opacity: stepOpacity(idx) }}
            />
            <StepLabel label={step.label} detail={details?.[step.nodeId]} className="min-w-0 flex-1 text-muted-foreground" />
            <span className="font-medium tabular-nums">{step.count.toLocaleString()}</span>
            {step.excluded > 0 && (
              <span className="tabular-nums text-muted-foreground/70">
                (-{step.excluded.toLocaleString()})
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/** The CONSORT layout: steps down the middle, what each criterion excluded to the side. */
function AttritionFlowchart({ attrition, details }: AttritionChartProps) {
  const { t } = useTranslation()
  const total = attrition[0]?.count ?? 0
  const share = (n: number) => (total > 0 ? `${((n / total) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })} %` : '')

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-stretch">
      {attrition.map((step, idx) => {
        const last = idx === attrition.length - 1
        return (
          <div key={step.nodeId} className="flex flex-col items-stretch">
            {idx > 0 && (
              <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                <div />
                <div className="h-6 w-px bg-border" />
                {step.excluded > 0 ? (
                  <div className="flex items-center">
                    <div className="h-px w-4 bg-border" />
                    <div className="rounded-md border border-dashed px-2 py-1 text-[10px] text-muted-foreground">
                      {t('cohorts.attrition_excluded', { count: step.excluded, formatted: step.excluded.toLocaleString() })}
                    </div>
                  </div>
                ) : <div />}
              </div>
            )}
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-center',
                last ? 'border-primary bg-primary/10' : 'bg-card',
              )}
            >
              <StepLabel
                label={idx === 0 ? t('cohorts.attrition_all') : step.label}
                detail={details?.[step.nodeId]}
                className="text-xs text-muted-foreground"
              />
              <div className="text-sm font-semibold tabular-nums">
                {step.count.toLocaleString()}
                {idx > 0 && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{share(step.count)}</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
