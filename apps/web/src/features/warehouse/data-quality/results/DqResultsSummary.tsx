import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionLabel } from '@/components/ui/section-label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STATUS_HEX, STATUS_ORDER } from '@/lib/dq-report/charts'
import { scoreOf, tallyByCategory, tallyBySeverity, tallyOf, type DqResultRow, type DqTally } from '@/lib/dq-report/tally'
import { cn } from '@/lib/utils'
import { scoreColor, STATUS_CONFIG } from '../DqConstants'

/**
 * What a run found, at a glance: the score, the checks by status, and the same
 * split per Kahn dimension and per severity. Counts only the rows given, so a
 * filtered run is summarised as shown.
 */
export function DqResultsSummary({ rows }: { rows: DqResultRow[] }) {
  const { t } = useTranslation()
  const tally = useMemo(() => tallyOf(rows), [rows])
  const byCategory = useMemo(() => tallyByCategory(rows), [rows])
  const bySeverity = useMemo(() => tallyBySeverity(rows), [rows])
  const score = scoreOf(tally)

  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-3 px-4 py-3">
      <div className="flex items-center gap-5">
        <div>
          <SectionLabel>{t('dq_report.kpi_score')}</SectionLabel>
          <div className={cn('text-2xl font-bold tabular-nums', scoreColor(score ?? undefined))}>
            {score == null ? '—' : `${score}%`}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('data_quality.checks_passed', { passed: tally.passed, total: tally.total - tally.notApplicable })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {STATUS_ORDER.map(({ status, field }) => {
            const cfg = STATUS_CONFIG[status]
            const Icon = cfg.icon
            return (
              <div key={status} className="flex items-center gap-1.5 text-xs">
                <Icon size={13} className={cfg.color} />
                <span className="w-8 text-right font-medium tabular-nums">{tally[field]}</span>
                <span className="text-muted-foreground">{t(`data_quality.${cfg.label}`)}</span>
              </div>
            )
          })}
        </div>
      </div>
      <StatusBars
        title={t('dq_report.chart_dimensions')}
        rows={byCategory.map(({ key, tally: tl }) => ({ key, label: t(`data_quality.category_${key}`), tally: tl }))}
      />
      <StatusBars
        title={t('dq_report.chart_severities')}
        rows={bySeverity.map(({ key, tally: tl }) => ({ key, label: t(`data_quality.severity_${key}`), tally: tl }))}
      />
    </div>
  )
}

function StatusBars({ title, rows }: { title: string; rows: { key: string; label: string; tally: DqTally }[] }) {
  return (
    <div className="min-w-56 flex-1">
      <SectionLabel className="mb-1">{title}</SectionLabel>
      <div className="space-y-1">
        {rows.map((row) => {
          const score = scoreOf(row.tally)
          return (
            <div key={row.key} className="flex items-center gap-2 text-xs">
              <span className="w-24 shrink-0 truncate text-muted-foreground">{row.label}</span>
              <StatusBar tally={row.tally} className="h-2.5 flex-1" />
              <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{score == null ? '—' : `${score}%`}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One bar split by status, a 2px gap between segments, each with its count on hover. */
export function StatusBar({ tally, className }: { tally: DqTally; className?: string }) {
  const { t } = useTranslation()
  const shown = STATUS_ORDER.filter(({ field }) => tally[field] > 0)
  return (
    <div className={cn('flex gap-0.5 overflow-hidden rounded-sm bg-muted', className)}>
      {shown.map(({ status, field }) => (
        <Tooltip key={status}>
          <TooltipTrigger asChild>
            <span
              className="h-full min-w-0.5 rounded-sm"
              style={{ flexGrow: tally[field], flexBasis: 0, backgroundColor: STATUS_HEX[status] }}
              aria-label={`${t(`data_quality.status_${status}`)}: ${tally[field]}`}
            />
          </TooltipTrigger>
          <TooltipContent>{t(`data_quality.status_${status}`)}: {tally[field]}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
