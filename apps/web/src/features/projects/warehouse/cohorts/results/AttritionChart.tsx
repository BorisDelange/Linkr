import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { cn } from '@/lib/utils'
import type { AttritionStep } from '@/types'

interface AttritionChartProps {
  attrition: AttritionStep[]
}

type AttritionView = 'bars' | 'flowchart'

const BAR_SIZE = 14
const ROW_HEIGHT = 26

/** Later steps fade, so the eye follows the funnel down. */
const stepOpacity = (idx: number) => Math.max(0.35, 1 - idx * 0.12)

export function AttritionChart({ attrition }: AttritionChartProps) {
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
      {view === 'bars' ? <AttritionBars attrition={attrition} /> : <AttritionFlowchart attrition={attrition} />}
    </div>
  )
}

function AttritionBars({ attrition }: AttritionChartProps) {
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
              width={140}
              tick={{ fontSize: 10 }}
            />
            <Tooltip
              formatter={(value) => [Number(value).toLocaleString(), t('cohorts.attrition_count')]}
              labelFormatter={(label) => label}
              cursor={{ fill: 'var(--color-accent)' }}
              // Recharts' unstyled default renders at the browser's base font
              // size, twice the chrome around it. Same values every other chart
              // in the app passes.
              contentStyle={{ fontSize: 11, background: 'var(--color-popover)', border: '1px solid var(--color-border)', color: 'var(--color-popover-foreground)' }}
              itemStyle={{ fontSize: 11 }}
              labelStyle={{ fontSize: 11 }}
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
            <span className="flex-1 truncate text-muted-foreground">{step.label}</span>
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
function AttritionFlowchart({ attrition }: AttritionChartProps) {
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
              <div className="truncate text-xs text-muted-foreground" title={step.label}>
                {idx === 0 ? t('cohorts.attrition_all') : step.label}
              </div>
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
