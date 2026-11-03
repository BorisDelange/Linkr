import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, AlertCircle, BedDouble, HeartPulse, Loader2, Square, Users } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/ui/stat-card'
import { ChartTooltipCard } from '@/features/projects/lab/datasets/analyses/chart-tooltip'
import type { ChartItem } from '@/lib/cohort-report/charts'
import { CohortReportUnavailable, shapeCohortReportModel } from '@/lib/cohort-report/model'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import type { Cohort, DataSource } from '@/types'
import { useCohortStore } from '@/stores/cohort-store'
import { useCohortFigures } from '../report/cohort-figures'

interface CohortStatisticsPanelProps {
  /** The cohort as the result shown was run. */
  cohort: Cohort
  source: DataSource
}

const SEX_COLORS = ['var(--color-chart-1)', 'var(--color-chart-4)', 'var(--color-chart-3)', 'var(--color-chart-2)', 'var(--color-chart-5)']

/**
 * The cohort described as its report does — counts, deaths, age, sex,
 * admissions over time, care units — from the same figures: computed once for
 * the definition, whichever of the two asks first. Exact counts: the
 * small-cell rule is the report's, for what leaves Linkr.
 */
export function CohortStatisticsPanel({ cohort, source }: CohortStatisticsPanelProps) {
  const { t, i18n } = useTranslation()
  // Not while the cohort itself runs: its queries come first, and its run ends
  // (the Run button back) only once its count is stored.
  const executing = useCohortStore((s) => s.executionAborts.has(cohort.id))
  // Computed with the cohort's run: each run reads them again.
  const runAt = useCohortStore((s) => s.executionResults.get(cohort.id)?.executedAt)
  const figures = useCohortFigures(cohort, source, { withFlow: false, enabled: !executing, runAt })
  const { state, data } = figures
  const mapping = source.schemaMapping
  const model = useMemo(() => (data && mapping
    ? shapeCohortReportModel(data, {
      cohort, mapping, databaseName: localized(source.name, i18n.language), t, locale: i18n.language, threshold: 1,
    })
    : null), [data, mapping, cohort, source.name, t, i18n.language])
  const running = state?.status === 'running' || (!state && !!mapping)

  const err = state?.status === 'error' ? state.error : null
  const message = !mapping ? t('cohort_report.needs_mapping')
    : state?.status === 'stopped' ? t('cohorts.stats_stopped')
      : err == null ? null
        : err instanceof CohortReportUnavailable ? t(`cohort_report.unavailable_${err.reason}`)
          : t('cohorts.stats_error', { message: err instanceof Error ? err.message : String(err) })

  /** Why a chart is empty: its section has nothing to ask of this mapping, or no rows. */
  const emptyReason = (block: string, items: unknown[], notMapped: string) =>
    items.length > 0 ? undefined : data && !(block in data.blocks) ? notMapped : t('cohorts.stats_no_rows')
  const kpi = (label: string) => model?.kpis.find((k) => k.label === label)
  const unitLabel = t(`cohort_report.unit_${cohort.level}`)

  return (
    <div className="@container h-full overflow-auto">
      <div className="space-y-5 p-4">
        {(running || model) && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {running ? (
                <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{t('cohorts.stats_computing')}</span>
              ) : t('cohorts.stats_computed_at', { date: formatDateTimeLocale(model!.generatedAt, i18n.language) })}
            </span>
            {running && (
              <Button variant="destructive" size="sm" onClick={figures.stop} className="h-6 gap-1 text-xs">
                <Square size={12} />
                {t('cohorts.stop')}
              </Button>
            )}
          </div>
        )}

        {message && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="break-words">{message}</span>
          </p>
        )}

        {!model && running && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[74px]" />)}
            </div>
            <div className="grid gap-4 @3xl:grid-cols-2">
              <Skeleton className="h-56" />
              <Skeleton className="h-56" />
            </div>
          </div>
        )}

        {model && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                icon={<Users size={16} className="text-emerald-600 dark:text-emerald-400" />}
                iconBg="bg-emerald-500/10"
                value={model.kpis[0].count.label}
                label={model.kpis[0].label}
              />
              {model.mortality && (
                <StatCard
                  icon={<HeartPulse size={16} className="text-rose-600 dark:text-rose-400" />}
                  iconBg="bg-rose-500/10"
                  value={model.mortality.rate != null ? `${model.mortality.rate}\u00A0%` : model.mortality.deaths.label}
                  label={t('cohorts.stats_mortality')}
                />
              )}
              {cohort.level !== 'visit' && kpi(t('cohort_report.kpi_visits')) && (
                <StatCard
                  icon={<Activity size={16} className="text-violet-600 dark:text-violet-400" />}
                  iconBg="bg-violet-500/10"
                  value={kpi(t('cohort_report.kpi_visits'))!.count.label}
                  label={t('cohort_report.kpi_visits')}
                />
              )}
              {cohort.level !== 'patient' && kpi(unitLabel) && (
                <StatCard
                  icon={<BedDouble size={16} className="text-sky-600 dark:text-sky-400" />}
                  iconBg="bg-sky-500/10"
                  value={kpi(unitLabel)!.count.label}
                  label={unitLabel}
                />
              )}
            </div>

            <div className="grid gap-4 @3xl:grid-cols-2">
              <ChartBlock title={t('cohort_report.chart_age')} empty={emptyReason('age', model.age, t('cohorts.stats_no_age'))}>
                <CountBars items={model.age} unit={unitLabel} />
              </ChartBlock>
              <ChartBlock title={t('cohort_report.chart_sex')} empty={emptyReason('sex', model.sex, t('cohorts.stats_not_mapped'))}>
                <SexDonut items={model.sex} />
              </ChartBlock>
            </div>

            <ChartBlock title={t('cohort_report.chart_months', { unit: unitLabel })} empty={emptyReason('months', model.months, t('cohorts.stats_not_mapped'))}>
              <CountBars items={model.months} unit={unitLabel} dense />
            </ChartBlock>

            {model.careUnits.length > 0 && (
              <ChartBlock title={t('cohort_report.chart_units')} info={t('cohort_report.units_caption')}>
                <UnitBars items={model.careUnits} unit={t('cohort_report.unit_visit_detail')} />
              </ChartBlock>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ChartBlock({ title, info, empty, children }: { title: string; info?: string; empty?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <SectionLabel as="h3" info={info}>{title}</SectionLabel>
      {empty ? <p className="mt-3 text-xs text-muted-foreground">{empty}</p> : <div className="mt-3">{children}</div>}
    </section>
  )
}

const rows = (items: ChartItem[]) => items.map((i) => ({ label: i.label, n: i.count.value ?? 0, shown: i.count.label }))

const AXIS_TICK = { fontSize: 10, fill: 'var(--color-muted-foreground)' }

/** Counts over an ordered axis: age bands, months. */
function CountBars({ items, unit, dense = false }: { items: ChartItem[]; unit: string; dense?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={dense ? 200 : 220}>
      <BarChart data={rows(items)} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap={dense && items.length > 40 ? 0 : '15%'}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={dense ? 16 : 4} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} width={44} />
        <Tooltip
          cursor={{ fill: 'var(--color-accent)', opacity: 0.5 }}
          content={({ active, payload }) => {
            const d = active ? payload?.[0]?.payload as ReturnType<typeof rows>[number] | undefined : undefined
            return d ? <ChartTooltipCard title={d.label} rows={[{ label: unit, value: d.shown }]} /> : null
          }}
        />
        <Bar dataKey="n" fill="var(--color-chart-1)" radius={dense ? 0 : [3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function SexDonut({ items }: { items: ChartItem[] }) {
  const { t, i18n } = useTranslation()
  const data = rows(items)
  const total = data.reduce((s, d) => s + d.n, 0)
  const share = (n: number) => (total ? (n / total * 100).toLocaleString(i18n.language, { maximumFractionDigits: 1 }) : '0')
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={data} dataKey="n" nameKey="label" cy="45%" innerRadius="52%" outerRadius="78%" stroke="none" isAnimationActive={false}>
          {data.map((d, i) => <Cell key={d.label} fill={SEX_COLORS[i % SEX_COLORS.length]} />)}
        </Pie>
        <Legend
          layout="horizontal"
          align="center"
          verticalAlign="bottom"
          iconSize={8}
          iconType="circle"
          formatter={(value: string) => {
            const d = data.find((x) => x.label === value)
            return <span className="text-xs text-muted-foreground">{value} · {d?.shown} ({share(d?.n ?? 0)} %)</span>
          }}
        />
        <Tooltip
          content={({ active, payload }) => {
            const d = active ? payload?.[0]?.payload as (typeof data)[number] | undefined : undefined
            return d ? <ChartTooltipCard title={d.label} rows={[{ label: t('cohort_report.kpi_patients'), value: d.shown, note: `(${share(d.n)} %)` }]} /> : null
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

/** Care units, largest first, as horizontal bars with their names beside. */
function UnitBars({ items, unit }: { items: ChartItem[]; unit: string }) {
  const data = rows(items.slice(0, 15))
  return (
    <ResponsiveContainer width="100%" height={Math.max(80, data.length * 24 + 16)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} width={180} />
        <Tooltip
          cursor={{ fill: 'var(--color-accent)', opacity: 0.5 }}
          content={({ active, payload }) => {
            const d = active ? payload?.[0]?.payload as (typeof data)[number] | undefined : undefined
            return d ? <ChartTooltipCard title={d.label} rows={[{ label: unit, value: d.shown }]} /> : null
          }}
        />
        <Bar dataKey="n" fill="var(--color-chart-2)" radius={[0, 3, 3, 0]} barSize={14} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}
