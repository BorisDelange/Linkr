import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { DqReport } from '@/lib/duckdb/data-quality'

export function DqScoreBadge({ report }: { report: DqReport }) {
  const applicable = report.summary.total - report.summary.notApplicable
  const pct = applicable > 0 ? Math.round((report.summary.passed / applicable) * 100) : 100
  const color = pct >= 95 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
    : pct >= 80 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
      : 'bg-red-500/15 text-red-700 dark:text-red-400'

  return (
    <Badge variant="outline" className={cn('gap-1 font-mono', color)}>
      {pct}%
    </Badge>
  )
}
