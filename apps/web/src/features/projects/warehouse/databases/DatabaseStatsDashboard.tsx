import { Fragment, useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Users, Activity, BarChart3, Table } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { computeDatabaseStats, streamTableCounts } from '@/lib/duckdb/database-stats'
import { useDataSourceStore } from '@/stores/data-source-store'
import type {
  DatabaseStatsCache, AgePyramidBucket, AdmissionTimelineBucket,
  DescriptiveStats, GenderDistribution, SchemaMapping,
} from '@/types'

interface DatabaseStatsDashboardProps {
  dataSourceId: string
  schemaMapping: SchemaMapping
  sourceStatus?: string
  /** False when no data model is attached: patient/visit figures cannot be
   *  derived, but per-table row counts still can. */
  hasMappedSchema?: boolean
}

// Shared across hook instances: the sheet mounts useDatabaseStats twice (summary
// cards + table list). Without this, both would launch the full recompute at
// once for the same source. Keyed by dataSourceId → the in-flight refresh promise.
const _inFlight = new Map<string, Promise<void>>()

export function useDatabaseStats(dataSourceId: string, schemaMapping: SchemaMapping, sourceStatus?: string) {
  const [cache, setCache] = useState<DatabaseStatsCache | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [cacheLoaded, setCacheLoaded] = useState(false)
  const autoRefreshed = useRef(false)

  useEffect(() => {
    autoRefreshed.current = false
    setCacheLoaded(false)
    setCache(null)
    getStorage().databaseStatsCache.get(dataSourceId).then((cached) => {
      if (cached) setCache(cached)
      setCacheLoaded(true)
    })
  }, [dataSourceId])

  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      // Dedupe across the sheet's two hook instances: only one compute runs per
      // source. The owner streams live updates into its own state; a concurrent
      // instance awaits the shared promise, then loads the final cache from IDB.
      const existing = _inFlight.get(dataSourceId)
      if (existing) {
        await existing
        const cached = await getStorage().databaseStatsCache.get(dataSourceId)
        if (cached) setCache(cached)
        return
      }

      const run = (async () => {
        await ensureMounted(dataSourceId)
        // Fast block first (patients/visits/age/gender/timeline) — renders in a
        // few seconds. Persist it right away so switching tabs (which unmounts
        // this panel) reloads from cache instead of recomputing from zero.
        const stats = await computeDatabaseStats(dataSourceId, schemaMapping)
        setCache(stats)
        await getStorage().databaseStatsCache.save(stats)

        // Per-table counts stream in afterwards, batch by batch, persisting after
        // each batch so a mid-stream tab switch keeps the counts gathered so far.
        let running = stats
        await streamTableCounts(dataSourceId, schemaMapping, (batch) => {
          running = {
            ...running,
            tableCounts: [...running.tableCounts, ...batch].sort((a, b) => b.rowCount - a.rowCount),
          }
          setCache(running)
          getStorage().databaseStatsCache.save(running).catch(() => {})
        })
      })()
      _inFlight.set(dataSourceId, run)
      try {
        await run
      } finally {
        _inFlight.delete(dataSourceId)
      }
    } catch (err) {
      console.error('Failed to compute database stats:', err)
    } finally {
      setIsLoading(false)
    }
  }, [dataSourceId, schemaMapping, ensureMounted])

  // Auto-compute stats only in front-only mode. In server mode the source may be
  // a database of billions of rows, so we never run COUNT(*) automatically — the
  // user triggers computation explicitly via refresh() ("Load statistics").
  useEffect(() => {
    if (isServerMode()) return
    if (!cacheLoaded || isLoading || autoRefreshed.current) return
    if (sourceStatus && sourceStatus !== 'connected') return
    if (!cache || !cache.genderDistribution) {
      autoRefreshed.current = true
      refresh()
    }
  }, [cache, cacheLoaded, isLoading, refresh, sourceStatus])

  return { cache, isLoading, refresh }
}

export function DatabaseStatsDashboard({
  dataSourceId,
  schemaMapping,
  sourceStatus,
  hasMappedSchema = true,
}: DatabaseStatsDashboardProps) {
  const { t, i18n } = useTranslation()
  const { cache, isLoading, refresh } = useDatabaseStats(dataSourceId, schemaMapping, sourceStatus)

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }

  // Before the first run the prompt below is the trigger, so the toolbar would
  // be a second button for the same action right above it.
  const neverLoaded = !cache && !isLoading

  return (
    // Sections sit 8 apart. The toolbar is a control strip, not a section, so
    // the element after it overrides that gap down to 3 — keyed off the toolbar
    // itself (`[&+*]`) rather than a position, since the toolbar is conditional
    // and an nth-child rule would tighten the wrong gap when it is absent.
    // A negative margin did this before and pulled up whatever followed,
    // including the no-data-model notice, which slid under the refresh button.
    <div className="space-y-5">
      {!neverLoaded && (
        <div className="flex items-center justify-between [&+*]:!mt-3">
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
      )}

      {/* Nothing computed yet: offer the same explicit trigger the overview tab
          shows, so the tab is not an empty shell before the first run. */}
      {neverLoaded && <LoadStatisticsPrompt onLoad={refresh} />}

      {!hasMappedSchema && <NoDataModelNotice />}

      {/* ── Section 1: Patients ── */}
      {hasMappedSchema && !neverLoaded && (
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
      )}

      {/* ── Section 2: Visits & visit units ── */}
      {hasMappedSchema && !neverLoaded && (
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
      )}

      {/* ── Section 3: Row counts per table ── */}
      {cache && cache.tableCounts.length > 0 && (
        <section>
          <SectionHeader icon={Table} title={t('databases.stats_table_overview')} />
          <div className="mt-4 space-y-1">
            {cache.tableCounts.map(({ tableName, rowCount }) => (
              <div
                key={tableName}
                className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5"
              >
                <span className="text-xs font-mono">{tableName}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {rowCount.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Shown in the Statistics tab of a database with no data model attached: the
 *  clinical figures cannot be derived, but the row counts above still can. */
function NoDataModelNotice() {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-dashed px-4 py-4">
      <p className="text-xs font-medium">{t('databases.stats_no_data_model')}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('databases.stats_no_data_model_hint')}
      </p>
    </div>
  )
}

/** Explicit "run the stats now" prompt: COUNT(*) over every table can be slow,
 *  so nothing is computed until asked. */
export function LoadStatisticsPrompt({ onLoad }: { onLoad: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center">
      <BarChart3 size={20} className="text-muted-foreground" />
      <p className="text-xs text-muted-foreground">
        {t('databases.load_statistics_hint')}
        <br />
        {t('databases.load_statistics_hint_2')}
      </p>
      <Button
        size="sm"
        onClick={onLoad}
        className="gap-1.5 bg-foreground text-background hover:bg-foreground/90"
      >
        <BarChart3 size={14} />
        {t('databases.load_statistics')}
      </Button>
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

interface TooltipEntry {
  name: string
  value: number
  color?: string
  fill?: string
  /** The datum the series was built from — a pie keeps the slice colour here. */
  payload?: { fill?: string; color?: string }
}

/**
 * The swatch colour for one tooltip row, or undefined when the series has none.
 *
 * A bar or line puts it on the entry itself, but a Pie leaves `color`/`fill`
 * undefined and carries the Cell's fill one level down, on the datum. Reading
 * only the top level left the pie with a transparent 8px swatch that still took
 * its grid column — the "margin" to the left of the label.
 */
function entryColor(entry: TooltipEntry): string | undefined {
  return entry.color || entry.fill || entry.payload?.fill || entry.payload?.color
}

/** Shared custom tooltip matching the app design system. */
function ChartTooltip({ active, payload, label }: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  // Without a colour the swatch is invisible, so drop the column rather than
  // reserve width for something that never paints.
  const showSwatch = payload.some((entry) => entryColor(entry) !== undefined)
  return (
    // A grid, not a stack of flex rows: each column is sized by its widest cell,
    // so the values line up across series without `ml-auto` stretching a short
    // row to a width the content never asked for. The box is absolutely
    // positioned, so `w-fit` keeps it from being laid out against the viewport.
    <div className="w-fit rounded-md border bg-popover px-3 py-2 shadow-md">
      {/* A pie passes the slice index as `label`; only a real category name is
          worth a heading, and a stray "0" above the row widened the box. */}
      {label != null && label !== '' && typeof label === 'string' && (
        <p className="mb-1 text-[11px] font-medium text-foreground">{label}</p>
      )}
      <div
        className={`grid items-center gap-x-2 gap-y-0.5 text-[11px] ${
          showSwatch ? 'grid-cols-[auto_auto_auto]' : 'grid-cols-[auto_auto]'
        }`}
      >
        {payload.map((entry) => (
          <Fragment key={entry.name}>
            {showSwatch && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: entryColor(entry) }}
              />
            )}
            <span className="text-muted-foreground">{entry.name}</span>
            <span className="justify-self-end font-medium tabular-nums text-foreground">
              {entry.value.toLocaleString()}
            </span>
          </Fragment>
        ))}
      </div>
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
          formatter={(value: string, _entry) => {
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
    // Two columns: each row is a short label and a short value, so one column
    // left most of the width empty and made the list twice as tall as it needs.
    <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
      {rows.map(({ label, value }) => (
        <div
          key={label}
          className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-1.5"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
          <span className="shrink-0 text-xs font-medium tabular-nums">{value}</span>
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

/** An x-axis tick rotated -45°, ending at the tick rather than hanging past it. */
function RotatedDateTick({ x, y, payload }: {
  x?: number
  y?: number
  payload?: { value: string }
}) {
  if (x == null || y == null || !payload) return null
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      transform={`rotate(-45, ${x}, ${y})`}
      className="fill-muted-foreground"
      fontSize={10}
    >
      {payload.value}
    </text>
  )
}

function AdmissionTimelineChart({ data }: { data: AdmissionTimelineBucket[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart
        data={data}
        margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        {/* A custom tick rather than `angle` + `tick={{…}}`: recharts anchors a
            bottom axis's text with verticalAnchor="start", so a rotated label
            grows downward from the tick and its end hangs below the axis. That
            prop is filtered out of `tick`, so the rotation is applied here
            instead, around a point just under the tick — which puts the end of
            the text at the tick, where it belongs. */}
        <XAxis
          dataKey="month"
          interval="preserveStartEnd"
          tick={<RotatedDateTick />}
          // Not for rendering — the custom tick does that — but for spacing:
          // getTicks() measures each label's projected width from `angle`, and
          // without it recharts assumes horizontal text, over-spaces, and drops
          // a tick that would in fact have fitted.
          angle={-45}
          height={56}
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
