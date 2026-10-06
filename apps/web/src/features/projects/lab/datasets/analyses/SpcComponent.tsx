import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, LineChart } from 'lucide-react'
import { AnalysisLoading, usePluginName } from '@/components/ui/analysis-loading'
import { localized } from '@/lib/localized'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import type { LocalizedString } from '@/types'
import { getLucideIcon, resolveColor, TOOLTIP_STYLE, CHART_RESIZE_DEBOUNCE_MS } from '@/lib/plugins/shared-styles'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import { computeSpc } from '@/lib/spc/spc-compute'
import type { SpcConfig } from '@/lib/spc/spc-compute'
import type { ChartPoint, SpcResult, SpcWarning } from '@/lib/spc/spc-types'
import { classifyVariation, hasFewCrossings } from '@/lib/spc/spc-variation'
import type { ImprovementDirection, Variation } from '@/lib/spc/spc-variation'

/** How a special-cause period is marked on the line: a ringed dot, a tinted
 *  full-height column, or a tinted segment of the control band. */
type SignalDisplay = 'points' | 'column' | 'band'
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
      deviceFilterColumn: columnName(config.deviceFilterColumn) || undefined,
      deviceFilterValues: Array.isArray(config.deviceFilterValues) ? (config.deviceFilterValues as string[]) : undefined,
      exposureEntity: columnName(config.exposureEntity) || undefined,
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
  const pluginName = usePluginName('spc')
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

  const spec = server && datasetFileId && ready ? buildSpcSpec(spcConfig) : null
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
  if (server && !serverLoaded) return <AnalysisLoading icon={LineChart} name={pluginName} compact={compact} />
  if (!result || result.points.length === 0) return <Placeholder text={t('analyses.spc_no_data')} />

  return <SpcChart result={result} config={config} compact={compact} />
}

interface ChartProps {
  result: SpcResult
  config: Record<string, unknown>
  compact?: boolean
}

function SpcChart({ result, config, compact }: ChartProps) {
  const { t, i18n } = useTranslation()
  const decimals = typeof config.decimals === 'number' ? config.decimals : 1
  const showGrid = config.showGrid !== false
  const showLegend = config.showLegend !== false
  const centerTitle = config.centerTitle !== false
  const showBaselineSplit = config.showBaselineSplit !== false
  const lineColor = resolveColor((config.lineColor as string) ?? 'blue').hex
  const signalColor = resolveColor((config.signalColor as string) ?? 'red').hex
  const direction = (config.improvementDirection as ImprovementDirection) ?? 'none'
  // NHS "Making Data Count": orange for a concern; blue for an improvement in the
  // original, teal here since blue is the line's own default colour.
  const variationColor: Record<Variation, string> = {
    common: lineColor,
    concern: resolveColor('orange').hex,
    improvement: resolveColor('teal').hex,
    special: signalColor,
  }
  const bgColorName = (config.bgColor as string) ?? 'none'
  const bg = bgColorName === 'none' ? undefined : resolveColor(bgColorName).bg
  const titleColorName = (config.titleColor as string) ?? 'auto'
  const titleColor = titleColorName === 'auto' ? undefined : resolveColor(titleColorName).text
  const iconName = (config.cardIcon as string) ?? '__none__'
  const title = localized(config.title as LocalizedString | string | undefined, i18n.language).trim()
  const yLabel = ((config.yLabel as string) ?? '') || defaultYLabel(result, t)
  const bars = config.display === 'bars'
  // Bars already carry the signal colour; the tint modes only apply to the line.
  const signalDisplay: SignalDisplay = bars ? 'points' : ((config.signalDisplay as SignalDisplay) ?? 'points')
  const tinted = signalDisplay !== 'points'
  // Proportions are computed as fractions and read as percentages.
  const percent = result.yUnit === '%'
  const fmt = (v: number) => (percent ? `${formatValue(v * 100, decimals)} %` : formatValue(v, decimals))

  // Recharts needs one flat row per point; the limits ride along so each is
  // drawn at its own height — the staircase that makes a varying denominator
  // visible.
  const variations = classifyVariation(result.points, direction)
  const data = result.points.map((p, i) => ({
    date: p.date,
    value: p.value,
    ucl: p.ucl,
    lcl: p.lcl,
    // The control band: a tinted area between the limits reads as "the expected
    // range" without the dashed lines competing with the data.
    band: Number.isFinite(p.lcl) && Number.isFinite(p.ucl) ? [p.lcl, p.ucl] : null,
    centre: p.centre,
    variation: variations[i],
    // One full-width column per flagged period (hidden 0–1 axis), or the band
    // segment of that period only: both are bars, so each sits centred on its point.
    signalColumn: signalDisplay === 'column' && variations[i] !== 'common' ? 1 : null,
    signalBand: signalDisplay === 'band' && variations[i] !== 'common' && Number.isFinite(p.lcl) && Number.isFinite(p.ucl) ? [p.lcl, p.ucl] : null,
    numerator: p.numerator,
    denominator: p.denominator,
    signals: p.signals,
  }))

  const firstAfterBaseline =
    showBaselineSplit && result.baselineCount > 0 && result.baselineCount < result.points.length
      ? result.points[result.baselineCount].date
      : null

  const countOf = (kind: Variation) => variations.filter(v => v === kind).length
  const fewCrossings = hasFewCrossings(result.points)

  return (
    <div className={cn('flex h-full w-full flex-col gap-1 p-2', bg)}>
      {title && (
        <div className={cn('flex items-center gap-1.5 text-sm font-medium', centerTitle && 'justify-center', titleColor)}>
          <TitleIcon name={iconName} />
          <span className="truncate">{title}</span>
        </div>
      )}

      {result.warnings.length > 0 && !compact && <Warnings warnings={result.warnings} />}

      {/* Clipped: the tooltip mounts once at an unmeasured position before Recharts
          moves it into the plot, which flashed a scrollbar on the widget. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE_MS} width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} barCategoryGap={tinted ? 0 : undefined}>
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
              // Ticks are round numbers: no trailing ".0".
              tickFormatter={(v: number) => fmt(v).replace(/\.0+(?= |$)/, '')}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value, name) => [
                Array.isArray(value)
                  ? `${fmt(Number(value[0]))} – ${fmt(Number(value[1]))}`
                  : fmt(typeof value === 'number' ? value : Number(value)),
                t(`analyses.spc_series_${name}`, { defaultValue: String(name) }),
              ]}
            />

            {firstAfterBaseline && (
              <ReferenceLine
                x={firstAfterBaseline}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                label={{ value: t('analyses.spc_limits_frozen'), position: 'top', style: { fontSize: 9, fill: 'var(--color-muted-foreground)' } }}
              />
            )}

            {signalDisplay === 'column' && (
              <>
                <YAxis yAxisId="signal" domain={[0, 1]} hide />
                <Bar yAxisId="signal" dataKey="signalColumn" tooltipType="none" isAnimationActive={false}>
                  {data.map(d => <Cell key={d.date} fill={variationColor[d.variation]} fillOpacity={0.14} />)}
                </Bar>
              </>
            )}
            {signalDisplay === 'band' && (
              <Bar dataKey="signalBand" tooltipType="none" isAnimationActive={false}>
                {data.map(d => <Cell key={d.date} fill={variationColor[d.variation]} fillOpacity={0.3} />)}
              </Bar>
            )}
            {/* `step` turns halfway between periods, so each limit sits centred on its own point. */}
            <Area type="step" dataKey="band" fill={lineColor} fillOpacity={0.1} stroke="none" isAnimationActive={false} activeDot={false} connectNulls />
            <Line type="linear" dataKey="centre" stroke="var(--color-muted-foreground)" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            {bars ? (
              <Bar dataKey="value" maxBarSize={28} radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {data.map(d => <Cell key={d.date} fill={variationColor[d.variation]} />)}
              </Bar>
            ) : (
              // Straight segments: a spline would invent values between periods.
              <Line
                type="linear"
                dataKey="value"
                stroke={lineColor}
                strokeWidth={2}
                // Common-cause dots stay small and in the line's colour; a special
                // cause gets a larger dot ringed in the card colour, which cuts it
                // out of the line instead of sitting on it like a stain.
                dot={(props: { cx?: number; cy?: number; index?: number; payload?: { variation: Variation } }) => {
                  if (!Number.isFinite(props.cx) || !Number.isFinite(props.cy)) return <g key={props.index} />
                  const variation = props.payload?.variation ?? 'common'
                  if (variation === 'common') return <circle key={props.index} cx={props.cx} cy={props.cy} r={2.5} fill={lineColor} />
                  // The tint already marks the period: the dot only takes its colour.
                  if (tinted) return <circle key={props.index} cx={props.cx} cy={props.cy} r={3} fill={variationColor[variation]} />
                  return (
                    <circle key={props.index} cx={props.cx} cy={props.cy} r={4.5} fill={variationColor[variation]} stroke="var(--color-card)" strokeWidth={2} />
                  )
                }}
                // Hover keeps the point's own colour: a signal must not turn blue under the cursor.
                activeDot={(props: { cx?: number; cy?: number; index?: number; payload?: { variation: Variation } }) => {
                  if (!Number.isFinite(props.cx) || !Number.isFinite(props.cy)) return <g key={props.index} />
                  const color = variationColor[props.payload?.variation ?? 'common']
                  return <circle key={props.index} cx={props.cx} cy={props.cy} r={5.5} fill={color} stroke="var(--color-card)" strokeWidth={2} />
                }}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {showLegend && !compact && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          <span>{t('analyses.spc_chart_type', { type: chartLabel(result.chartType, t) })}</span>
          <span>{t('analyses.spc_centre', { value: fmt(result.centre) })}</span>
          {result.sigmaZ !== undefined && result.sigmaZ > 1.05 && (
            <span>{t('analyses.spc_dispersion', { value: result.sigmaZ.toFixed(2) })}</span>
          )}
          {direction === 'none' ? (
            <VariationCount count={countOf('special')} color={variationColor.special} label={t('analyses.spc_signal_count', { count: countOf('special') })} />
          ) : (
            <>
              <VariationCount count={countOf('concern')} color={variationColor.concern} label={t('analyses.spc_concern_count', { count: countOf('concern') })} />
              <VariationCount count={countOf('improvement')} color={variationColor.improvement} label={t('analyses.spc_improvement_count', { count: countOf('improvement') })} />
            </>
          )}
          {fewCrossings && <span>{t('analyses.spc_few_crossings')}</span>}
        </div>
      )}
    </div>
  )
}

function VariationCount({ count, color, label }: { count: number; color: string; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', count > 0 && 'font-medium')} style={count > 0 ? { color } : undefined}>
      {count > 0 && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
    </span>
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

function chartLabel(type: SpcResult['chartType'], t: TFunction): string {
  return t(`analyses.spc_type_${type}`, { defaultValue: type })
}

function defaultYLabel(result: SpcResult, t: TFunction): string {
  if (result.yUnit && result.yUnit !== '%') return t('analyses.spc_y_rate', { basis: result.yUnit.replace('/', '') })
  if (result.chartType === 'g' || result.chartType === 't') return t('analyses.spc_y_interval')
  return ''
}

/** Only used by `SpcComponent`'s local path; kept typed for the chart props. */
export type { ChartPoint }
