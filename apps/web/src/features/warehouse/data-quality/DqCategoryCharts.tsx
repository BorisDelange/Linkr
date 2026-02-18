import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import type { DqCheck, DqCheckResult, DqCategory } from '@/lib/duckdb/data-quality'
import { CATEGORY_COLORS } from './DqConstants'

interface Props {
  checks: DqCheck[]
  results: DqCheckResult[]
}

const CATEGORY_ORDER: DqCategory[] = [
  'completeness', 'validity', 'uniqueness', 'consistency', 'plausibility',
]

// Extract the first Tailwind color class and map to a hex for Recharts
const CATEGORY_HEX: Record<DqCategory, string> = {
  completeness: '#3b82f6', // blue-500
  validity: '#a855f7',     // purple-500
  uniqueness: '#f59e0b',   // amber-500
  consistency: '#06b6d4',  // cyan-500
  plausibility: '#22c55e', // green-500
}

export function DqCategoryCharts({ checks, results }: Props) {
  const { t } = useTranslation()

  const data = useMemo(() => {
    const resultMap = new Map(results.map((r) => [r.checkId, r]))

    return CATEGORY_ORDER.map((cat) => {
      const catChecks = checks.filter((c) => c.category === cat)
      const catResults = catChecks
        .map((c) => resultMap.get(c.id))
        .filter((r): r is DqCheckResult => r != null && r.status !== 'not_applicable')

      const total = catResults.length
      const failed = catResults.filter((r) => r.status === 'fail' || r.status === 'error').length
      const failRate = total > 0 ? Math.round((failed / total) * 100) : 0

      return {
        category: t(`data_quality.category_${cat}`),
        catKey: cat,
        total: catChecks.length,
        applicable: total,
        passed: total - failed,
        failed,
        failRate,
      }
    })
  }, [checks, results, t])

  return (
    <div className="flex gap-4 px-4 py-3">
      {/* Distribution by category */}
      <div className="flex-1">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('data_quality.chart_distribution')}
        </p>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={data} barSize={20}>
            <XAxis
              dataKey="category"
              tick={{ fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              width={28}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 8,
                backgroundColor: 'var(--color-popover)',
                color: 'var(--color-popover-foreground)',
                border: '1px solid var(--color-border)',
              }}
              cursor={false}
              itemStyle={{ color: 'var(--color-popover-foreground)' }}
              labelStyle={{ color: 'var(--color-popover-foreground)' }}
              formatter={(value: number) => [value, t('data_quality.chart_checks')]}
            />
            <Bar dataKey="total" radius={[3, 3, 0, 0]}>
              {data.map((entry) => (
                <Cell key={entry.catKey} fill={CATEGORY_HEX[entry.catKey]} fillOpacity={0.7} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Failure rate by category */}
      <div className="flex-1">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('data_quality.chart_failure_rate')}
        </p>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={data} barSize={20}>
            <XAxis
              dataKey="category"
              tick={{ fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              width={32}
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 8,
                backgroundColor: 'var(--color-popover)',
                color: 'var(--color-popover-foreground)',
                border: '1px solid var(--color-border)',
              }}
              cursor={false}
              itemStyle={{ color: 'var(--color-popover-foreground)' }}
              labelStyle={{ color: 'var(--color-popover-foreground)' }}
              formatter={(value: number) => [`${value}%`, t('data_quality.chart_fail_pct')]}
            />
            <Bar dataKey="failRate" radius={[3, 3, 0, 0]}>
              {data.map((entry) => (
                <Cell
                  key={entry.catKey}
                  fill={entry.failRate === 0 ? '#22c55e' : entry.failRate <= 20 ? '#f59e0b' : '#ef4444'}
                  fillOpacity={0.7}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
