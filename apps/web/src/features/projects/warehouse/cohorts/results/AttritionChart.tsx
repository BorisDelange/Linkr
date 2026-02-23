import { useTranslation } from 'react-i18next'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { AttritionStep } from '@/types'

interface AttritionChartProps {
  attrition: AttritionStep[]
}

export function AttritionChart({ attrition }: AttritionChartProps) {
  const { t } = useTranslation()

  if (attrition.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('cohorts.attrition_empty')}
      </div>
    )
  }

  const total = attrition[0]?.count ?? 0

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Bar chart */}
      <div className="h-48 min-h-[12rem]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={attrition}
            layout="vertical"
            margin={{ top: 0, right: 20, left: 0, bottom: 0 }}
          >
            <XAxis type="number" domain={[0, total || 'auto']} hide />
            <YAxis
              type="category"
              dataKey="label"
              width={120}
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              formatter={(value: number) => [value.toLocaleString(), t('cohorts.attrition_count')]}
              labelFormatter={(label: string) => label}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {attrition.map((step, idx) => (
                <Cell
                  key={step.nodeId}
                  fill={idx === 0 ? 'var(--color-primary)' : `hsl(var(--primary) / ${0.8 - idx * 0.08})`}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Text summary */}
      <div className="space-y-1">
        {attrition.map((step, idx) => (
          <div
            key={step.nodeId}
            className="flex items-center gap-2 text-xs"
          >
            <div
              className="h-2.5 w-2.5 rounded-sm shrink-0"
              style={{
                backgroundColor: idx === 0 ? 'var(--color-primary)' : `hsl(var(--primary) / ${0.8 - idx * 0.08})`,
              }}
            />
            <span className="flex-1 text-muted-foreground truncate">{step.label}</span>
            <span className="font-medium tabular-nums">{step.count.toLocaleString()}</span>
            {step.excluded > 0 && (
              <span className="text-muted-foreground/70 tabular-nums">
                (-{step.excluded.toLocaleString()})
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
