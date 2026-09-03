import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle } from 'lucide-react'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { getLucideIcon, resolveColor, TOOLTIP_STYLE } from '@/lib/plugins/shared-styles'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import { computeSpc } from '@/lib/spc/spc-compute'
import type { SpcConfig } from '@/lib/spc/spc-compute'
import type { ChartPoint, SpcResult, SpcWarning } from '@/lib/spc/spc-types'
import { buildSpcSpec } from './spc-server'
import { cn } from '@/lib/utils'

/** Read the config into the shape computeSpc expects, resolving ids to names. */
function useSpcConfig(config: Record<string, unknown>, columnName: (id: unknown) => string): SpcConfig {
  return useMemo(() => {
    const str = (key: string) => {
      const v = config[key]
      return typeof v === 'string' && v ? v : undefined
    }
    const num = (key: string) => {
      const v = config[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    }
    return {
      statisticType: (config.statisticType as SpcConfig['statisticType']) ?? 'auto',
      chartType: (config.chartType as SpcConfig['chartType']) ?? 'auto',
      dateColumn: columnName(config.dateColumn),
      valueColumn: columnName(config.valueColumn),
      period: (config.period as SpcConfig['period']) ?? 'month',
      eventValues: Array.isArray(config.eventValues) ? (config.eventValues as string[]) : undefined,
      denominatorMode: (config.denominatorMode as SpcConfig['denominatorMode']) ?? 'cases',
      exposureColumn: columnName(config.exposureColumn) || undefined,
      admissionColumn: columnName(config.admissionColumn) || undefined,
      dischargeColumn: columnName(config.dischargeColumn) || undefined,
      deviceStartColumn: columnName(config.deviceStartColumn) || undefined,
      deviceEndColumn: columnName(config.deviceEndColumn) || undefined,
      deduplicateBy: columnName(config.deduplicateBy) || undefined,
      aggregation: (config.aggregation as SpcConfig['aggregation']) ?? 'median',
      rateBasis: num('rateBasis') ?? 1000,
      // The config panel enforces min/max as HTML attributes only, with no
      // programmatic clamp — so a typed-in 0 or 99 would otherwise reach the
      // maths and produce limits of zero or infinite width.
      sigmaWidth: clamp(num('limitSigma') ?? 3, 1, 5),
      lambda: clamp(num('lambda') ?? 0.2, 0.05, 1),
      target: num('target'),
      runsRules: (config.runsRules as SpcConfig['runsRules']) ?? 'anhoj',
      runLength: clamp(num('runLength') ?? 6, 3, 12),
      baselineUntil: str('baselineUntil'),
    }
  }, [config, columnName])
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function SpcComponent({ config, columns, rows, compact, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t } = useTranslation()
  const server = isServerMode()

  const columnName = useMemo(() => {
    const byId = new Map(columns.map(c => [c.id, c.name]))
    return (id: unknown) => (typeof id === 'string' ? (byId.get(id) ?? '') : '')
  }, [columns])

  const spcConfig = useSpcConfig(config, columnName)
  const ready = Boolean(spcConfig.dateColumn && spcConfig.valueColumn)

  const localResult = useMemo(() => {
    if (server || !ready) return null
    return computeSpc(rows, spcConfig)
  }, [server, ready, rows, spcConfig])

  const spec = server && datasetFileId && ready ? buildSpcSpec(columns, spcConfig) : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverResult, setServerResult] = useState<SpcResult | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoaded, setServerLoaded] = useState(false)

  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('spc', spec, { datasetFileId, datasetFilters })
      .then(out => {
        if (cancelled) return
        setServerLoaded(true)
        if (out.stderr) {
          setServerError(out.stderr)
          return
        }
        try {
          const parsed = out.stdout.trim() === 'null' ? null : (JSON.parse(out.stdout.trim()) as SpcResult)
          setServerResult(parsed)
          setServerError(null)
        } catch {
          setServerError(out.stdout || 'Failed to parse result')
        }
      })
      .catch(e => {
        if (!cancelled) {
          setServerLoaded(true)
          setServerError(String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const result = server ? serverResult : localResult

  if (!ready) return <Placeholder text={t('analyses.spc_select_columns')} />
  if (server && serverError) return <Placeholder text={serverError} />
  if (server && !serverLoaded) return <Placeholder text={t('common.loading')} />
  if (!result || result.points.length === 0) return <Placeholder text={t('analyses.spc_no_data')} />

  return <SpcChart result={result} config={config} compact={compact} />
}

interface ChartProps {
  result: SpcResult
  config: Record<string, unknown>
  compact?: boolean
}

function SpcChart({ result, config, compact }: ChartProps) {
  const { t } = useTranslation()
  const decimals = typeof config.decimals === 'number' ? config.decimals : 1
  const showGrid = config.showGrid !== false
  const showLegend = config.showLegend !== false
  const centerTitle = config.centerTitle !== false
  const showBaselineSplit = config.showBaselineSplit !== false
  const lineColor = resolveColor((config.lineColor as string) ?? 'blue').hex
  const signalColor = resolveColor((config.signalColor as string) ?? 'red').hex
  const bgColorName = (config.bgColor as string) ?? 'none'
  const bg = bgColorName === 'none' ? undefined : resolveColor(bgColorName).bg
  const titleColorName = (config.titleColor as string) ?? 'auto'
  const titleColor = titleColorName === 'auto' ? undefined : resolveColor(titleColorName).text
  const iconName = (config.cardIcon as string) ?? '__none__'
  const title = (config.title as string) ?? ''
  const yLabel = ((config.yLabel as string) ?? '') || defaultYLabel(result, t)

  // Recharts needs one flat row per point; the limits ride along so each is
  // drawn at its own height — the staircase that makes a varying denominator
  // visible.
  const data = result.points.map(p => ({
    date: p.date,
    value: p.value,
    ucl: p.ucl,
    lcl: p.lcl,
    centre: p.centre,
    signal: p.signals.length > 0 ? p.value : null,
    numerator: p.numerator,
    denominator: p.denominator,
    signals: p.signals,
  }))

  const firstAfterBaseline =
    showBaselineSplit && result.baselineCount > 0 && result.baselineCount < result.points.length
      ? result.points[result.baselineCount].date
      : null

  const signalCount = result.points.filter(p => p.signals.length > 0).length

  return (
    <div className={cn('flex h-full w-full flex-col gap-1 p-2', bg)}>
      {title && (
        <div className={cn('flex items-center gap-1.5 text-sm font-medium', centerTitle && 'justify-center', titleColor)}>
          <TitleIcon name={iconName} />
          <span className="truncate">{title}</span>
        </div>
      )}

      {result.warnings.length > 0 && !compact && <Warnings warnings={result.warnings} />}

      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />}
            <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" minTickGap={24} />
            <YAxis
              tick={{ fontSize: 10 }}
              stroke="var(--color-muted-foreground)"
              width={48}
              label={
                yLabel && !compact
                  ? { value: yLabel, angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'var(--color-muted-foreground)' } }
                  : undefined
              }
              tickFormatter={(v: number) => formatValue(v, decimals)}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value: number, name: string) => [formatValue(value, decimals), t(`analyses.spc_series_${name}`, name)]}
            />

            {firstAfterBaseline && (
              <ReferenceLine
                x={firstAfterBaseline}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                label={{ value: t('analyses.spc_limits_frozen'), position: 'top', style: { fontSize: 9, fill: 'var(--color-muted-foreground)' } }}
              />
            )}

            <Line type="stepAfter" dataKey="ucl" stroke={signalColor} strokeDasharray="5 3" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
            <Line type="stepAfter" dataKey="lcl" stroke={signalColor} strokeDasharray="5 3" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="centre" stroke="var(--color-muted-foreground)" strokeWidth={1} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="value" stroke={lineColor} strokeWidth={2} dot={{ r: 2.5, fill: lineColor }} isAnimationActive={false} />
            {/* Flagged points are drawn on top, so a signal reads at a glance. */}
            <Scatter dataKey="signal" fill={signalColor} shape="circle" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {showLegend && !compact && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          <span>{t('analyses.spc_chart_type', { type: chartLabel(result.chartType, t) })}</span>
          <span>{t('analyses.spc_centre', { value: formatValue(result.centre, decimals) })}</span>
          {result.sigmaZ !== undefined && result.sigmaZ > 1.05 && (
            <span>{t('analyses.spc_dispersion', { value: result.sigmaZ.toFixed(2) })}</span>
          )}
          <span className={cn(signalCount > 0 && 'font-medium')} style={signalCount > 0 ? { color: signalColor } : undefined}>
            {t('analyses.spc_signal_count', { count: signalCount })}
          </span>
        </div>
      )}
    </div>
  )
}

function TitleIcon({ name }: { name: string }) {
  if (!name || name === '__none__') return null
  const Icon = getLucideIcon(name)
  return (
    // eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data
    <Icon className="h-4 w-4 shrink-0" />
  )
}

/** The warnings that change how a chart should be read, not that block it. */
function Warnings({ warnings }: { warnings: SpcWarning[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-0.5">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{t(`analyses.spc_warning_${w.code}`, { detail: w.detail ?? '' })}</span>
        </div>
      ))}
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <p className="whitespace-pre-wrap text-sm">{text}</p>
    </div>
  )
}

function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(decimals)
}

function chartLabel(type: SpcResult['chartType'], t: (key: string, opts?: object) => string): string {
  return t(`analyses.spc_type_${type}`, { defaultValue: type })
}

function defaultYLabel(result: SpcResult, t: (key: string, opts?: object) => string): string {
  if (result.yUnit) return t('analyses.spc_y_rate', { basis: result.yUnit.replace('/', '') })
  if (result.chartType === 'g' || result.chartType === 't') return t('analyses.spc_y_interval')
  return ''
}

/** Only used by `SpcComponent`'s local path; kept typed for the chart props. */
export type { ChartPoint }
