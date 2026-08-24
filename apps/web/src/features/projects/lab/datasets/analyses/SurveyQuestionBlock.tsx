/**
 * One questionnaire question, rendered as a self-contained block: the question
 * as asked, a response-rate bar, and the chart its type calls for.
 *
 * Presentational and config-free on purpose. The dashboard plugin
 * (SurveyQuestionComponent) resolves a widget config into these props; the
 * Reports page will map over `schema.questions` and render one block each,
 * reproducing a whole questionnaire report. Both callers need the same thing —
 * "here is the question, here are the rows" — so that is the whole API.
 *
 * The chart rules come from docs/planning/survey-plugin-plan.md §3.2. The two
 * that shape the code most:
 *  - percentages are over RESPONDENTS, and for a multiple-choice question they
 *    legitimately exceed 100%;
 *  - a scale keeps its declared order — sorting a 1..5 by frequency destroys it.
 *
 * Chart craft follows the app's other plugins (Plot Builder, Key Indicator) and
 * the dataset column-stats sidebar: a dashed CartesianGrid, round `niceTicks` on
 * the count axis, `TruncatedTick` labels with a hover tooltip for the full text,
 * and TOOLTIP_STYLE hovers. Category lists are ranked bars-in-rows rather than a
 * bare table — the sidebar's shape, which reads at a glance and never clips.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { DatasetColumn } from '@/types'
import { resolveColor, resolvePalette, TOOLTIP_STYLE } from '@/lib/plugins/shared-styles'
import { niceTicks, tightHistogramScale } from '@/lib/chart-ticks'
import { BoxPlot } from '@/components/charts/box-plot'
import { TruncatedTick, TruncatedNumericTick } from './chart-axis-helpers'
import {
  summarizeQuestion,
  sortCounts,
  toNumber,
  type AnswerCount,
  type CountSort,
  type QuestionSummary,
} from '@/lib/survey/survey-analysis'
import {
  questionColumns,
  type SurveyQuestion,
  type SurveySchema,
} from '@/lib/survey/survey-schema'
import { defaultChart, type SurveyChart } from './survey-charts'
import { questionKindLabel } from '@/lib/survey/question-kind-label'

export interface SurveyQuestionBlockProps {
  schema: SurveySchema
  question: SurveyQuestion
  rows: Record<string, unknown>[]
  chart?: SurveyChart
  /** Fill opacity 0..1 for bars and slices. */
  opacity?: number
  /** Fixed bar thickness in px; 0 = automatic (a histogram spans its bin). */
  barSize?: number
  /** Characters shown on the X axis before truncating. */
  xLabelMaxLen?: number
  /** Decimal places on axis numbers and percentages. */
  decimals?: number
  /** Colour name (or hex) of the histogram's median marker. */
  medianColor?: string
  /** Anchor the histogram's x axis at zero instead of hugging the data. */
  xAxisStartZero?: boolean
  /** Answer codes in display order, for `sort: 'custom'`. */
  choiceOrder?: string[]
  sort?: CountSort
  /** Override the question text; empty keeps the question as asked. */
  title?: string
  showQuestionText?: boolean
  showResponseRate?: boolean
  valueLabel?: 'both' | 'count' | 'percent' | 'none'
  hideEmptyChoices?: boolean
  /** 0 = every option; otherwise the rest are grouped as "Others". */
  maxChoices?: number
  color?: string
  palette?: string
  bins?: number
  showMedian?: boolean
  showGrid?: boolean
  /** Dense rendering, for a dashboard widget. */
  compact?: boolean
  lang?: string
  /**
   * A summary computed elsewhere — the server, in fullstack mode, where `rows`
   * is empty because the data never reaches the browser. Same shape either way,
   * so the rendering below does not branch on where the numbers came from.
   */
  summary?: QuestionSummary
  /** Numeric values for the histogram, when `summary` came from the server. */
  values?: number[]
  /** The dataset columns, for the question's identity tooltip (id/label/description). */
  columns?: DatasetColumn[]
}

function pickText(label: Record<string, string> | undefined, lang: string): string {
  if (!label) return ''
  return label[lang] ?? label.fr ?? label.en ?? label.und ?? Object.values(label)[0] ?? ''
}

/** Whole numbers with grouped thousands — a count axis never wants `4.4e+3`. */
function formatCount(val: number | string): string {
  const n = typeof val === 'string' ? Number(val) : val
  if (!isFinite(n)) return String(val)
  return Math.round(n).toLocaleString(undefined, { useGrouping: true })
}

/** `42 (58%)` — the label style the CNP-CEMIR report uses on every bar. */
function formatValue(
  count: number,
  proportion: number,
  mode: NonNullable<SurveyQuestionBlockProps['valueLabel']>,
): string {
  const pct = `${(proportion * 100).toFixed(0)}%`
  switch (mode) {
    case 'count':
      return String(count)
    case 'percent':
      return pct
    case 'none':
      return ''
    default:
      return `${count} (${pct})`
  }
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * n/N with a filled bar — the response-rate indicator every slide of the source
 * report carries. Non-response is a finding, not a footnote.
 */
function ResponseRate({ summary, compact }: { summary: QuestionSummary; compact?: boolean }) {
  const { t } = useTranslation()
  const pct = summary.total > 0 ? (summary.respondents / summary.total) * 100 : 0
  return (
    <div className="shrink-0 space-y-1" style={{ width: compact ? 120 : 150 }}>
      <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{t('survey.answered')}</span>
        <span className="tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      {/* Green answered / red missing, matching the column-stats sidebar's
          completeness bar — the same reading in both places. */}
      <div className="h-3 w-full overflow-hidden rounded-sm bg-destructive/15">
        <div className="h-full rounded-sm bg-emerald-500/70 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums text-muted-foreground">
        <span>{t('survey.n_answered', { count: summary.respondents })}</span>
        <span>{t('survey.n_missing', { count: summary.missing })}</span>
      </div>
    </div>
  )
}

/** Fold everything past `max` into a single "Others" row, so a long option list
 *  stays readable without silently dropping its tail. */
function capCounts(counts: AnswerCount[], max: number, othersLabel: string): AnswerCount[] {
  if (max <= 0 || counts.length <= max) return counts
  const head = counts.slice(0, max)
  const tail = counts.slice(max)
  const count = tail.reduce((acc, c) => acc + c.count, 0)
  const proportion = tail.reduce((acc, c) => acc + c.proportion, 0)
  return [...head, { code: '__others__', label: othersLabel, count, proportion }]
}

export function SurveyQuestionBlock({
  schema,
  question,
  rows,
  chart = 'auto',
  choiceOrder,
  opacity = 0.7,
  barSize = 0,
  xLabelMaxLen = 20,
  decimals = 1,
  medianColor = 'red',
  xAxisStartZero = false,
  sort = 'frequency',
  title,
  showQuestionText = true,
  showResponseRate = true,
  valueLabel = 'both',
  hideEmptyChoices = false,
  maxChoices = 0,
  color = 'blue',
  palette = 'default',
  bins = 0,
  showMedian = true,
  showGrid = true,
  compact,
  lang = 'fr',
  summary: providedSummary,
  values: providedValues,
  columns,
}: SurveyQuestionBlockProps) {
  const { t } = useTranslation()

  const localSummary = useMemo(
    () => (providedSummary ? null : summarizeQuestion(schema, question, rows, lang)),
    [providedSummary, schema, question, rows, lang],
  )
  const summary = providedSummary ?? localSummary!

  const effectiveChart = chart === 'auto' ? defaultChart(question) : chart

  // A scale's codes carry meaning (1..5); frequency order would destroy the
  // reading, so the declared order wins over an automatic sort. An explicit
  // custom order still wins over that — it was arranged by hand for this
  // question, so overriding it would be overruling a deliberate choice.
  const effectiveSort: CountSort =
    question.measure === 'ordinal' && sort !== 'custom' ? 'declared' : sort

  const counts = useMemo(() => {
    let list = summary.counts
    if (hideEmptyChoices) list = list.filter((c) => c.count > 0)
    list = sortCounts(list, effectiveSort, choiceOrder)
    return capCounts(list, maxChoices, t('survey.others'))
  }, [summary.counts, hideEmptyChoices, effectiveSort, choiceOrder, maxChoices, t])

  const questionText = title || pickText(question.label, lang) || question.name
  const resolved = resolveColor(color)

  // The question's own column, for the identity tooltip. A multiple-choice
  // question spans several columns; its FIRST one carries the shared metadata.
  const identityColumn = useMemo(() => {
    const first = questionColumns(question)[0]
    if (!first || !columns) return undefined
    return columns.find((c) => c.id === first || c.name === first)
  }, [question, columns])

  const header = (
    <div className="flex shrink-0 items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {showQuestionText && (
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <p
                  className={cn(
                    'cursor-default font-medium leading-snug text-foreground/90',
                    compact ? 'text-xs' : 'text-sm',
                  )}
                >
                  {questionText}
                </p>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-80">
                {/* Same three rows as a dataset column header's tooltip, so the
                    identity of a field reads identically wherever you meet it. */}
                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                  <span className="text-muted-foreground">{t('datasets.col_meta_col_id')}</span>
                  <span className="font-mono break-all">{identityColumn?.name ?? question.name}</span>
                  <span className="text-muted-foreground">{t('datasets.col_meta_label')}</span>
                  <span className="break-words">{identityColumn?.label || questionText || '—'}</span>
                  <span className="text-muted-foreground">{t('datasets.col_meta_description')}</span>
                  <span className="break-words">{identityColumn?.description || '—'}</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {questionKindLabel(question, t)}
          {question.kind === 'select_multiple' && summary.selections !== undefined && (
            <> · {t('survey.multi_footnote', { mean: (summary.meanSelections ?? 0).toFixed(1) })}</>
          )}
        </p>
        {question.relevant && (
          // The question was only asked on a branch, so its denominator is that
          // branch — say so rather than letting the reader assume the full sample.
          <p className="mt-0.5 text-[10px] italic text-muted-foreground">
            {t('survey.conditional_question')}
          </p>
        )}
      </div>
      {showResponseRate && <ResponseRate summary={summary} compact={compact} />}
    </div>
  )

  const body = (() => {
    if (questionColumns(question).length === 0) {
      return <Empty text={t('survey.no_columns')} />
    }
    if (summary.respondents === 0) {
      return <Empty text={t('survey.no_answers')} />
    }
    switch (effectiveChart) {
      case 'bar':
        return (
          <RankedBars
            counts={counts}
            valueLabel={valueLabel}
            hex={resolved.hex}
            compact={compact}
            opacity={opacity}
          />
        )
      case 'column':
        return (
          <ColumnChart
            counts={counts}
            valueLabel={valueLabel}
            hex={resolved.hex}
            showGrid={showGrid}
            compact={compact}
            opacity={opacity}
            barSize={barSize}
            xLabelMaxLen={xLabelMaxLen}
          />
        )
      case 'pie':
      case 'donut':
        return (
          <SharePie
            counts={counts}
            donut={effectiveChart === 'donut'}
            palette={palette}
            compact={compact}
            opacity={opacity}
            decimals={decimals}
          />
        )
      case 'histogram':
        return (
          <Histogram
            values={providedValues ?? numericValues(question, rows)}
            bins={bins}
            opacity={opacity}
            barSize={barSize}
            xLabelMaxLen={xLabelMaxLen}
            decimals={decimals}
            medianHex={resolveColor(medianColor).hex}
            startAtZero={xAxisStartZero}
            showMedian={showMedian}
            median={summary.stats?.median}
            hex={resolved.hex}
            showGrid={showGrid}
            compact={compact}
          />
        )
      case 'stats':
        return <Stats summary={summary} compact={compact} />
      case 'answers':
        return <AnswerList counts={counts} summary={summary} hex={resolved.hex} opacity={opacity} />
      case 'table':
        return <CountsTable counts={counts} valueLabel={valueLabel} hex={resolved.hex} />
      default:
        return <Empty text={t('survey.no_chart')} />
    }
  })()

  return (
    <div className={cn('flex h-full min-h-0 flex-col', compact ? 'p-3' : 'p-4')}>
      {header}
      <div className={cn('min-h-0 flex-1', compact ? 'mt-2' : 'mt-4')}>{body}</div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}

/** The parsed numeric answers of a numeric question. */
function numericValues(question: SurveyQuestion, rows: Record<string, unknown>[]): number[] {
  const column = questionColumns(question)[0]
  if (!column) return []
  const out: number[] = []
  for (const row of rows) {
    const n = toNumber(row[column])
    if (n !== null) out.push(n)
  }
  return out
}

// ---------------------------------------------------------------------------
// Category charts
// ---------------------------------------------------------------------------

/**
 * Ranked bars-in-rows: label above, bar below, `n (pct%)` on the right.
 *
 * This is the dataset column-stats sidebar's shape rather than a recharts
 * horizontal BarChart, and deliberately so: a questionnaire option is a full
 * sentence ("Réanimation polyvalente adulte"), which a recharts category axis
 * either truncates to nothing or eats half the widget to show. Giving the label
 * its own full-width line removes the tradeoff, and the list scrolls instead of
 * squeezing bars to a few pixels when a question has twenty options.
 */
function RankedBars({
  counts,
  valueLabel,
  hex,
  compact,
  opacity,
}: {
  counts: AnswerCount[]
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
  hex: string
  compact?: boolean
  opacity: number
}) {
  // Bars are scaled to the top count, not to the total: with a multiple-choice
  // question the proportions do not sum to 1, so a total-based scale would leave
  // every bar a stub. The percentage on the right carries the absolute reading.
  const top = Math.max(...counts.map((c) => c.count), 1)
  return (
    <div className="h-full space-y-1.5 overflow-auto pr-1">
      {counts.map((c) => (
        <div key={c.code}>
          <div className="mb-0.5 flex items-baseline justify-between gap-2">
            <span
              className={cn('min-w-0 flex-1 truncate text-muted-foreground', compact ? 'text-[10px]' : 'text-xs')}
              title={c.label}
            >
              {c.label}
            </span>
            {valueLabel !== 'none' && (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {formatValue(c.count, c.proportion, valueLabel)}
              </span>
            )}
          </div>
          <div className={cn('w-full overflow-hidden rounded-full bg-muted/60', compact ? 'h-1.5' : 'h-2')}>
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${(c.count / top) * 100}%`, backgroundColor: hex, opacity }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Vertical bars, for the few questions where the option order is the reading
 *  (a 1..5 scale) and the labels are short enough for an axis. */
function ColumnChart({
  counts,
  valueLabel,
  hex,
  showGrid,
  compact,
  opacity,
  barSize,
  xLabelMaxLen,
}: {
  counts: AnswerCount[]
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
  hex: string
  showGrid: boolean
  compact?: boolean
  opacity: number
  barSize: number
  xLabelMaxLen: number
}) {
  const data = counts.map((c) => ({ ...c, value: c.count }))
  // Round ticks, and headroom above the tallest bar so its value label is not
  // clipped by the plot edge.
  const scale = niceTicks([0, Math.max(...data.map((d) => d.value), 1) * 1.12], true)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: 0 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} vertical={false} />}
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval={0}
          height={compact ? 28 : 40}
          tick={<TruncatedTick maxLen={compact ? Math.min(8, xLabelMaxLen) : xLabelMaxLen} angle={-25} textAnchor="end" dy={8} />}
        />
        <YAxis
          type="number"
          tickLine={false}
          axisLine={false}
          width={40}
          domain={scale?.domain}
          ticks={scale?.ticks}
          tick={<TruncatedNumericTick formatter={formatCount} />}
        />
        <ChartTooltip
          {...TOOLTIP_STYLE}
          formatter={(value: unknown, _n: unknown, item: unknown) => {
            const p = (item as { payload?: AnswerCount })?.payload
            return [formatValue(Number(value), p?.proportion ?? 0, 'both'), '']
          }}
        />
        <Bar
          dataKey="value"
          fill={hex}
          fillOpacity={opacity}
          radius={[2, 2, 0, 0]}
          barSize={barSize || undefined}
          isAnimationActive={false}
          activeBar={{ fillOpacity: Math.min(1, opacity + 0.2), stroke: hex, strokeWidth: 1 }}
        >
          {valueLabel !== 'none' && (
            <LabelList
              dataKey="value"
              position="top"
              content={(props: { x?: string | number; y?: string | number; width?: string | number; index?: number }) => {
                const entry = data[props.index ?? 0]
                if (!entry) return null
                const num = (v: string | number | undefined) => (typeof v === 'number' ? v : Number(v ?? 0))
                return (
                  <text
                    x={num(props.x) + num(props.width) / 2}
                    y={num(props.y) - 4}
                    fontSize={9}
                    textAnchor="middle"
                    fill="currentColor"
                    className="fill-muted-foreground"
                  >
                    {formatValue(entry.count, entry.proportion, valueLabel)}
                  </text>
                )
              }}
            />
          )}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Pie / donut — only offered for single choice, where the parts are a whole.
 *
 * Slice labels are dropped in favour of a scrollable legend: a pie of long
 * questionnaire options draws leader lines over each other and over the chart.
 */
function SharePie({
  counts,
  donut,
  palette,
  compact,
  opacity,
  decimals,
}: {
  counts: AnswerCount[]
  donut: boolean
  palette: string
  compact?: boolean
  opacity: number
  decimals: number
}) {
  const { t } = useTranslation()
  const colors = resolvePalette(palette)
  const total = counts.reduce((s, c) => s + c.count, 0)
  const pct = (n: number) => (total ? (n / total) * 100 : 0)

  // Zero-count choices are dropped from the CIRCLE regardless of the "hide
  // empty" setting. A slice of zero draws no arc, but paddingAngle still
  // charges it a gap, so a question with ten unused options spent twenty
  // degrees on wedges of nothing — it looked like invisible values were being
  // plotted. The legend below still lists them, which is where a reader
  // actually wants to see that an option went unchosen.
  const drawn = counts.filter((c) => c.count > 0)

  return (
    <div className={cn('flex h-full min-h-0 w-full', compact ? 'flex-col' : 'items-center gap-3')}>
      <div className={cn('relative min-h-0', compact ? 'h-full w-full' : 'h-full flex-[3]')}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Pie
              data={drawn}
              dataKey="count"
              nameKey="label"
              cx="50%"
              cy="50%"
              // A thin ring rather than a thick one: the arc length carries the
              // value, so the extra ink adds nothing and a slim ring looks far
              // less like a 2005 business chart.
              innerRadius={donut ? '62%' : 0}
              outerRadius="86%"
              paddingAngle={drawn.length > 1 ? 2 : 0}
              // A hairline in the page's own background separates neighbouring
              // slices without drawing a visible outline around each.
              stroke="var(--color-background)"
              strokeWidth={2}
              fillOpacity={opacity}
              cornerRadius={donut ? 3 : 0}
              isAnimationActive={false}
              label={false}
            >
              {drawn.map((c) => (
                // Coloured by the choice's position in the FULL list, so a
                // colour keeps meaning the same answer whether or not some
                // other option happens to be empty.
                <Cell key={c.code} fill={colors[counts.indexOf(c) % colors.length]} />
              ))}
            </Pie>
            <ChartTooltip
              {...TOOLTIP_STYLE}
              formatter={(value: unknown, name: unknown) => [
                `${formatCount(Number(value))} (${pct(Number(value)).toFixed(decimals)}%)`,
                String(name),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* The hole is the natural place for the total, and an empty one just
            reads as a missing centre. Only for a donut — over a full pie this
            would sit on top of the slices. */}
        {donut && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn('font-semibold tabular-nums', compact ? 'text-sm' : 'text-lg')}>
              {formatCount(total)}
            </span>
            <span className="text-[10px] text-muted-foreground">{t('survey.col_count')}</span>
          </div>
        )}
      </div>

      {/* A real legend rather than recharts': the share is the point of a pie,
          and reading it off the slices is guesswork. Swatch, label, count and
          percentage, with the full label on hover when it is clipped. */}
      {!compact && (
        <ul className="h-full min-w-0 flex-[2] space-y-1.5 overflow-y-auto pr-1 text-xs">
          {counts.map((c, i) => (
            <li key={c.code} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: colors[i % colors.length] }}
                />
                <span className="min-w-0 flex-1 truncate" title={c.label}>
                  {c.label}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCount(c.count)}
                </span>
                <span className="w-11 shrink-0 text-right tabular-nums font-medium">
                  {pct(c.count).toFixed(decimals)}%
                </span>
              </div>
              {/* The share as a length as well as an angle: two slices a few
                  degrees apart are indistinguishable on the circle but obvious
                  as bars. */}
              <div className="ml-3.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct(c.count)}%`, background: colors[i % colors.length] }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Histogram with the median marked — the shape the source report uses for every
 * count question (beds, residents, seniors).
 */
function Histogram({
  values,
  bins,
  showMedian,
  median,
  hex,
  showGrid,
  compact,
  opacity,
  barSize,
  xLabelMaxLen,
  decimals,
  medianHex,
  startAtZero,
}: {
  values: number[]
  bins: number
  showMedian: boolean
  median?: number
  hex: string
  showGrid: boolean
  compact?: boolean
  opacity: number
  barSize: number
  xLabelMaxLen: number
  decimals: number
  medianHex: string
  startAtZero: boolean
}) {
  const { t } = useTranslation()

  const { data, width } = useMemo(() => {
    if (values.length === 0) return { data: [], width: 1 }
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (min === max) return { data: [{ center: min, start: min, end: min, value: values.length }], width: 1 }
    // Sturges' rule when the caller does not pick a bin count.
    const count = bins > 0 ? bins : Math.min(20, Math.ceil(Math.log2(values.length) + 1))
    const w = (max - min) / count
    const buckets = Array.from({ length: count }, (_, i) => ({
      start: min + i * w,
      end: min + (i + 1) * w,
      // Bars sit at the bin's CENTRE on a numeric axis, so a bar visually spans
      // the interval it counts instead of starting at its left edge.
      center: min + (i + 0.5) * w,
      value: 0,
    }))
    for (const v of values) {
      buckets[Math.min(count - 1, Math.floor((v - min) / w))].value++
    }
    return { data: buckets, width: w }
  }, [values, bins])

  // A REAL numeric x axis, not one category per bin. Bin edges are arbitrary
  // numbers (467.3, 1041.8…), so as categories they can never be round — the
  // axis has to carry the scale for the ticks to land on values a reader
  // recognises. It also puts the median line at its true position rather than
  // snapping it to the nearest bin label.
  const xScale = useMemo(() => {
    if (data.length === 0) return null
    const lo = data[0].start
    const hi = data[data.length - 1].end
    // Anchored at zero the axis shows where the data sits on an absolute scale;
    // tight, it hugs the real range so a span like 467..6025 does not waste
    // most of its width on empty space before the first bar.
    return startAtZero ? niceTicks([0, hi], true) : tightHistogramScale([lo, hi])
  }, [data, startAtZero])

  const yScale = niceTicks([0, Math.max(...data.map((d) => d.value), 1)], true)

  // Bin width as a fraction of the plotted domain, turned into pixels against
  // the container. Measured rather than assumed: the domain is padded half a
  // bin either side, so bins do not simply divide the width evenly.
  const [plotWidth, setPlotWidth] = useState(0)
  const holderRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    const measure = () => setPlotWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const domainSpan = xScale ? xScale.domain[1] - xScale.domain[0] : 0

  // Where the median label hangs relative to its line. Near the left edge it
  // has to start at the line and run right, near the right edge the reverse;
  // in the middle it can be centred.
  const medianLabelPosition = (() => {
    if (!xScale || median === undefined || domainSpan <= 0) return 'top' as const
    const at = (median - xScale.domain[0]) / domainSpan
    if (at < 0.15) return 'insideTopLeft' as const
    if (at > 0.85) return 'insideTopRight' as const
    return 'top' as const
  })()
  const axisPixels = Math.max(0, plotWidth - Y_AXIS_WIDTH)
  // An explicit thickness wins; otherwise a bar spans its bin exactly.
  const barPixels =
    barSize > 0
      ? barSize
      : domainSpan > 0 && axisPixels > 0
        ? Math.max(1, (width / domainSpan) * axisPixels - 1)
        : undefined

  if (data.length === 0) return <Empty text={t('survey.no_answers')} />

  return (
    <div ref={holderRef} className="h-full w-full">
    <ResponsiveContainer width="100%" height="100%">
      {/* top margin holds the median label: at 8px it was clipped away. */}
      <BarChart data={data} margin={{ top: showMedian && median !== undefined ? 18 : 8, right: 12, bottom: 4, left: 0 }}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />}
        <XAxis
          type="number"
          dataKey="center"
          domain={xScale ? xScale.domain : ['dataMin', 'dataMax']}
          ticks={xScale?.ticks}
          tickLine={false}
          axisLine={false}
          height={compact ? 20 : 24}
          tick={{ fontSize: compact ? 9 : 10, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(v) => truncate(formatAxisNumber(v, decimals), xLabelMaxLen)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={Y_AXIS_WIDTH}
          domain={yScale?.domain}
          ticks={yScale?.ticks}
          tick={<TruncatedNumericTick formatter={formatCount} />}
        />
        <ChartTooltip
          {...TOOLTIP_STYLE}
          // The bar's x is a bin CENTRE, which is not a value anyone entered.
          // Name the interval it stands for instead.
          labelFormatter={(_label, payload) => {
            const b = payload?.[0]?.payload as { start: number; end: number } | undefined
            if (!b) return ''
            return `${formatAxisNumber(b.start, decimals)} – ${formatAxisNumber(b.end, decimals)}`
          }}
          formatter={(value: unknown) => [formatCount(Number(value)), t('survey.col_count')]}
        />
        {/* A numeric axis gives recharts no category width to derive a bar
            width from, so it draws hairlines. The bin's share of the domain is
            the honest width: a histogram bar should span the interval it
            counts, leaving a small gap so adjacent bins stay legible. */}
        {/* Flat fill + fillOpacity + a stroke on hover: the Plot Builder bar,
            so the two read as the same chart drawn by the same hand. */}
        <Bar
          dataKey="value"
          fill={hex}
          fillOpacity={opacity}
          stroke="var(--color-background)"
          strokeWidth={1}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
          barSize={barPixels}
          maxBarSize={9999}
          activeBar={{ fillOpacity: Math.min(1, opacity + 0.2), stroke: hex, strokeWidth: 1 }}
        />
        {showMedian && median !== undefined && (
          <ReferenceLine
            x={median}
            stroke={medianHex}
            strokeDasharray="4 3"
            label={{
              value: `${t('survey.median_marker')} ${formatAxisNumber(median, decimals)}`,
              // Centred on the line, half the text falls outside the plot when
              // the median sits near an edge — and the SVG clips it. Anchor the
              // text away from whichever edge is closer instead.
              position: medianLabelPosition,
              fontSize: 10,
              fontWeight: 600,
              fill: medianHex,
            }}
          />
        )}
      </BarChart>
    </ResponsiveContainer>
    </div>
  )
}

/** Width reserved for the y axis, shared by the layout and the bar-width maths. */
const Y_AXIS_WIDTH = 40

/** Axis numbers with thousands separators and a caller-chosen precision. */
function formatAxisNumber(v: number | string, decimals = 1): string {
  const n = typeof v === 'string' ? Number(v) : v
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals })
}

/** Clip an axis label, matching Plot Builder's ellipsis. */
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, Math.max(1, maxLen - 1))}…` : text
}

// ---------------------------------------------------------------------------
// Non-chart renderers
// ---------------------------------------------------------------------------

/**
 * Descriptive statistics, laid out like the column-stats sidebar: paired rows,
 * then the box plot — which is the actual figure, and says more about the shape
 * of the distribution than the five numbers above it.
 */
function Stats({ summary, compact }: { summary: QuestionSummary; compact?: boolean }) {
  const { t } = useTranslation()
  const s = summary.stats
  if (!s) {
    return (
      <div className="space-y-1 text-xs">
        <StatRow label={t('survey.stat_respondents')} value={String(summary.respondents)} />
        <StatRow label={t('survey.stat_missing')} value={String(summary.missing)} />
      </div>
    )
  }
  return (
    <div className="h-full space-y-1 overflow-auto text-xs">
      <StatRow label={t('survey.stat_n')} value={String(s.n)} />
      <StatRow label={t('survey.stat_median')} value={`${round(s.median)} [${round(s.q1)} – ${round(s.q3)}]`} />
      <StatRow label={t('survey.stat_mean')} value={`${round(s.mean)} ± ${round(s.sd)}`} />
      <StatRow label={t('survey.stat_range')} value={`${round(s.min)} – ${round(s.max)}`} />
      <StatRow label={t('survey.stat_sum')} value={round(s.sum)} />
      {!compact && (
        <div className="pt-3">
          <BoxPlot min={s.min} p25={s.q1} median={s.median} p75={s.q3} max={s.max} mean={s.mean} height={44} />
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium tabular-nums">{value}</span>
    </div>
  )
}

/**
 * Free-text answers: the repeated ones as ranked bars, then the one-offs as a
 * plain list. The header states how many distinct answers there were, which is
 * what tells you whether the column is really an uncoded category list.
 */
function AnswerList({
  counts,
  summary,
  hex,
  opacity,
}: {
  counts: AnswerCount[]
  summary: QuestionSummary
  hex: string
  opacity: number
}) {
  const { t } = useTranslation()
  const repeated = counts.filter((c) => c.count > 1)
  const once = counts.filter((c) => c.count === 1)
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto pr-1">
      <p className="shrink-0 text-[10px] text-muted-foreground">
        {t('survey.distinct_answers', {
          distinct: summary.distinctAnswers ?? counts.length,
          respondents: summary.respondents,
        })}
      </p>
      {repeated.length > 0 && (
        <RankedBars counts={repeated} valueLabel="both" hex={hex} opacity={opacity} compact />
      )}
      {once.length > 0 && (
        <div className="min-h-0">
          {repeated.length > 0 && (
            <p className="mb-1 text-[10px] text-muted-foreground">
              {t('survey.given_once', { count: once.length })}
            </p>
          )}
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {once.map((c) => (
              <li key={c.code} className="truncate" title={c.label}>
                {c.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * The counts as a table, with the bar drawn behind the row: the numbers stay
 * exact and alignable, and the ranking is still readable at a glance.
 */
function CountsTable({
  counts,
  valueLabel,
  hex,
}: {
  counts: AnswerCount[]
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
  hex: string
}) {
  const { t } = useTranslation()
  const top = Math.max(...counts.map((c) => c.count), 1)
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b text-[10px] text-muted-foreground">
            <th className="py-1 pr-2 text-left font-medium">{t('survey.col_answer')}</th>
            <th className="w-20 py-1 text-right font-medium">{t('survey.col_count')}</th>
          </tr>
        </thead>
        <tbody>
          {counts.map((c) => (
            <tr key={c.code} className="relative border-b border-border/50 last:border-0">
              <td className="relative py-1 pr-2">
                {/* The bar sits behind the text rather than in its own column, so
                    a long option keeps the full width to wrap into. */}
                <span
                  aria-hidden
                  className="absolute inset-y-0.5 left-0 -z-10 rounded-sm"
                  style={{ width: `${(c.count / top) * 100}%`, backgroundColor: hex, opacity: 0.12 }}
                />
                <span title={c.label}>{c.label}</span>
              </td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">
                {formatValue(c.count, c.proportion, valueLabel === 'none' ? 'both' : valueLabel)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
