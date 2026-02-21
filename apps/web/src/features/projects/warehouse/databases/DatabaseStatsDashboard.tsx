import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Users, Activity } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getStorage } from '@/lib/storage'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import type {
  DatabaseStatsCache, AgePyramidBucket, AdmissionTimelineBucket,
  DescriptiveStats, GenderDistribution, SchemaMapping,
} from '@/types'

interface DatabaseStatsDashboardProps {
  dataSourceId: string
  schemaMapping: SchemaMapping
  sourceStatus?: string
}

export function useDatabaseStats(dataSourceId: string, schemaMapping: SchemaMapping, sourceStatus?: string) {
  const [cache, setCache] = useState<DatabaseStatsCache | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const autoRefreshed = useRef(false)

  useEffect(() => {
    autoRefreshed.current = false
    getStorage().databaseStatsCache.get(dataSourceId).then((cached) => {
      if (cached) setCache(cached)
    })
  }, [dataSourceId])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const stats = await computeDatabaseStats(dataSourceId, schemaMapping)
      await getStorage().databaseStatsCache.save(stats)
      setCache(stats)
    } catch (err) {
      console.error('Failed to compute database stats:', err)
    } finally {
      setIsLoading(false)
    }
  }, [dataSourceId, schemaMapping])

  // Auto-compute if no cache or cache is from an older schema (missing genderDistribution)
  // Wait until the source is connected before querying to avoid getting zeros from unmounted schemas
  useEffect(() => {
    if (isLoading || autoRefreshed.current) return
    if (sourceStatus && sourceStatus !== 'connected') return
    if (!cache || !cache.genderDistribution) {
      autoRefreshed.current = true
      refresh()
    }
  }, [cache, isLoading, refresh, sourceStatus])

  return { cache, isLoading, refresh }
}

export function DatabaseStatsDashboard({ dataSourceId, schemaMapping, sourceStatus }: DatabaseStatsDashboardProps) {
  const { t, i18n } = useTranslation()
  const { cache, isLoading, refresh } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }

  return (
    <div className="space-y-8">
      {/* Header with timestamp and refresh */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {cache
            ? t('databases.stats_last_refreshed', { date: formatDate(cache.computedAt) })
            : '\u00A0'}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isLoading}
          className="gap-1.5 text-xs"
        >
          <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
          {t('databases.stats_refresh')}
        </Button>
      </div>

      {/* ── Section 1: Patients ── */}
      <section>
        <SectionHeader icon={Users} title={t('databases.stats_section_patients')} />

        {isLoading && !cache ? (
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : cache ? (
          <div className="mt-4 grid grid-cols-2 gap-4">
            {/* Patient count */}
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground">
                {t('databases.stats_patient_count')}
              </p>
              <p className="mt-2 text-3xl font-bold tabular-nums">
                {cache.summary.patientCount.toLocaleString()}
              </p>
            </div>

            {/* Gender pie chart */}
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground">
                {t('databases.stats_gender_distribution')}
              </p>
              {(cache.genderDistribution && (cache.genderDistribution.male > 0 || cache.genderDistribution.female > 0)) ? (
                <div className="mt-1">
                  <GenderPieChart data={cache.genderDistribution} />
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('databases.stats_no_data')}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Section 2: Visits & visit units ── */}
      <section>
        <SectionHeader icon={Activity} title={t('databases.stats_section_visits')} />

        {isLoading && !cache ? (
          <div className="mt-4 space-y-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-64" />
            <Skeleton className="h-48" />
          </div>
        ) : cache ? (
          <div className="mt-4 space-y-6">
            {/* Visit count + visit detail count */}
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">
                  {t('databases.stats_visit_count')}
                </p>
                <p className="mt-2 text-3xl font-bold tabular-nums">
                  {cache.summary.visitCount.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">
                  {t('databases.stats_visit_detail_count')}
                </p>
                <p className="mt-2 text-3xl font-bold tabular-nums">
                  {cache.summary.visitDetailCount.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Key figures table */}
            {cache.descriptiveStats && (
              <DescriptiveStatsTable stats={cache.descriptiveStats} />
            )}

            {/* Age distribution histogram */}
            {cache.agePyramid.length > 0 && (
              <div>
                <h4 className="mb-3 text-xs font-medium text-muted-foreground">
                  {t('databases.stats_age_distribution')}
                </h4>
                <AgeHistogramChart data={cache.agePyramid} />
              </div>
            )}

            {/* Admission timeline */}
            {cache.admissionTimeline.length > 0 && (
              <div>
                <h4 className="mb-3 text-xs font-medium text-muted-foreground">
                  {t('databases.stats_admission_timeline')}
                </h4>
                <AdmissionTimelineChart data={cache.admissionTimeline} />
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}

// --- Sub-components ---

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={16} className="text-muted-foreground" />
      <h3 className="text-sm font-semibold">{title}</h3>
    </div>
  )
}

/** Shared custom tooltip matching the app design system. */
function ChartTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color?: string; fill?: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 shadow-md">
      {label && <p className="mb-1 text-[11px] font-medium text-foreground">{label}</p>}
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 text-[11px]">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color || entry.fill }}
          />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="ml-auto font-medium tabular-nums text-foreground">
            {entry.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

const GENDER_COLORS = {
  male: 'var(--color-chart-1)',
  female: 'var(--color-chart-4)',
  other: 'var(--color-chart-3)',
}

function GenderPieChart({ data }: { data: GenderDistribution }) {
  const { t } = useTranslation()
  const total = data.male + data.female + data.other
  const chartData = [
    { name: t('databases.stats_male'), value: data.male, color: GENDER_COLORS.male },
    { name: t('databases.stats_female'), value: data.female, color: GENDER_COLORS.female },
    ...(data.other > 0 ? [{ name: t('databases.stats_other'), value: data.other, color: GENDER_COLORS.other }] : []),
  ]

  return (
    <ResponsiveContainer width="100%" height={100}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius={25}
          outerRadius={40}
          dataKey="value"
          stroke="none"
        >
          {chartData.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Pie>
        <Legend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          iconSize={8}
          iconType="circle"
          formatter={(value: string, entry) => {
            const item = chartData.find((d) => d.name === value)
            const pct = item && total > 0 ? ((item.value / total) * 100).toFixed(0) : '0'
            return (
              <span className="text-[10px] text-muted-foreground">
                {value} ({pct}%)
              </span>
            )
          }}
        />
        <Tooltip content={<ChartTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  )
}

function DescriptiveStatsTable({ stats }: { stats: DescriptiveStats }) {
  const { t, i18n } = useTranslation()

  const formatDateShort = (iso: string | undefined) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium' })
    } catch {
      return iso
    }
  }

  const rows: { label: string; value: string }[] = []

  // Age stats
  if (stats.ageMean != null || stats.ageMedian != null) {
    rows.push({
      label: t('databases.stats_age_mean'),
      value: stats.ageMean != null ? `${stats.ageMean}` : '—',
    })
    rows.push({
      label: t('databases.stats_age_median'),
      value: stats.ageMedian != null ? `${stats.ageMedian}` : '—',
    })
    rows.push({
      label: t('databases.stats_age_range'),
      value: stats.ageMin != null && stats.ageMax != null
        ? `${stats.ageMin} – ${stats.ageMax}`
        : '—',
    })
    if (stats.ageQ1 != null && stats.ageQ3 != null) {
      rows.push({
        label: t('databases.stats_age_iqr'),
        value: `${stats.ageQ1} – ${stats.ageQ3}`,
      })
    }
  }

  // Date ranges
  if (stats.admissionDateMin || stats.admissionDateMax) {
    rows.push({
      label: t('databases.stats_admission_range'),
      value: `${formatDateShort(stats.admissionDateMin)} – ${formatDateShort(stats.admissionDateMax)}`,
    })
  }
  if (stats.dischargeDateMin || stats.dischargeDateMax) {
    rows.push({
      label: t('databases.stats_discharge_range'),
      value: `${formatDateShort(stats.dischargeDateMin)} – ${formatDateShort(stats.dischargeDateMax)}`,
    })
  }

  // Length of stay
  if (stats.losMean != null || stats.losMedian != null) {
    rows.push({
      label: t('databases.stats_los_mean'),
      value: stats.losMean != null ? `${stats.losMean} ${t('databases.stats_days')}` : '—',
    })
    rows.push({
      label: t('databases.stats_los_median'),
      value: stats.losMedian != null ? `${stats.losMedian} ${t('databases.stats_days')}` : '—',
    })
  }

  // Visits per patient
  if (stats.visitsPerPatientMean != null || stats.visitsPerPatientMedian != null) {
    rows.push({
      label: t('databases.stats_visits_per_patient_mean'),
      value: stats.visitsPerPatientMean != null ? `${stats.visitsPerPatientMean}` : '—',
    })
    rows.push({
      label: t('databases.stats_visits_per_patient_median'),
      value: stats.visitsPerPatientMedian != null ? `${stats.visitsPerPatientMedian}` : '—',
    })
    rows.push({
      label: t('databases.stats_visits_per_patient_range'),
      value: stats.visitsPerPatientMin != null && stats.visitsPerPatientMax != null
        ? `${stats.visitsPerPatientMin} – ${stats.visitsPerPatientMax}`
        : '—',
    })
  }

  // Visit unit length of stay
  if (stats.unitLosMean != null || stats.unitLosMedian != null) {
    rows.push({
      label: t('databases.stats_unit_los_mean'),
      value: stats.unitLosMean != null ? `${stats.unitLosMean} ${t('databases.stats_days')}` : '—',
    })
    rows.push({
      label: t('databases.stats_unit_los_median'),
      value: stats.unitLosMedian != null ? `${stats.unitLosMedian} ${t('databases.stats_days')}` : '—',
    })
  }

  if (rows.length === 0) return null

  return (
    <div className="space-y-1">
      {rows.map(({ label, value }) => (
        <div
          key={label}
          className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5"
        >
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-xs font-medium tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  )
}

/** Age order for sorting age groups. */
const AGE_ORDER = ['00-09', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90+']

function AgeHistogramChart({ data }: { data: AgePyramidBucket[] }) {
  const { t } = useTranslation()

  // Sort by age group order and convert to stacked bar data
  const sorted = [...data].sort(
    (a, b) => AGE_ORDER.indexOf(a.ageGroup) - AGE_ORDER.indexOf(b.ageGroup),
  )

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={sorted}
        margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis
          dataKey="ageGroup"
          tick={{ fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-accent)', opacity: 0.5 }} />
        <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
        <Bar
          dataKey="male"
          stackId="age"
          fill="var(--color-chart-1)"
          name={t('databases.stats_male')}
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="female"
          stackId="age"
          fill="var(--color-chart-4)"
          name={t('databases.stats_female')}
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

function AdmissionTimelineChart({ data }: { data: AdmissionTimelineBucket[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart
        data={data}
        margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 10 }}
          interval="preserveStartEnd"
          angle={-45}
          textAnchor="end"
          height={50}
        />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip content={<ChartTooltip />} />
        <Line
          type="monotone"
          dataKey="count"
          stroke="var(--color-chart-2)"
          strokeWidth={1.5}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
