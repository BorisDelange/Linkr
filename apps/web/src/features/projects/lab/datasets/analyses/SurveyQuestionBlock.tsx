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

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import { resolveColor, resolvePalette, TOOLTIP_STYLE } from '@/lib/plugins/shared-styles'
import { niceTicks } from '@/lib/chart-ticks'
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

export interface SurveyQuestionBlockProps {
  schema: SurveySchema
  question: SurveyQuestion
  rows: Record<string, unknown>[]
  chart?: SurveyChart
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
function ResponseRate({
  summary,
  compact,
  hex,
}: {
  summary: QuestionSummary
  compact?: boolean
  hex: string
}) {
  const { t } = useTranslation()
  const pct = Math.round(summary.responseRate * 100)
  return (
    <div
      className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground"
      title={t('survey.response_rate_hint', {
        respondents: summary.respondents,
        total: summary.total,
        missing: summary.missing,
      })}
    >
      <span className="whitespace-nowrap tabular-nums">
        {summary.respondents}/{summary.total} ({pct}%)
      </span>
      {/* The answered share takes the widget's own colour: `bg-primary` is a
          near-black in this theme, which read as chrome rather than as data. */}
      <span className={cn('flex overflow-hidden rounded-full bg-muted', compact ? 'h-1 w-12' : 'h-1.5 w-16')}>
        <span className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: hex }} />
      </span>
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
}: SurveyQuestionBlockProps) {
  const { t } = useTranslation()

  const localSummary = useMemo(
    () => (providedSummary ? null : summarizeQuestion(schema, question, rows, lang)),
    [providedSummary, schema, question, rows, lang],
  )
  const summary = providedSummary ?? localSummary!

  const effectiveChart = chart === 'auto' ? defaultChart(question) : chart

  // A scale's codes carry meaning (1..5); frequency order would destroy the
  // reading, so the declared order wins whatever the caller asked for.
  const effectiveSort: CountSort = question.measure === 'ordinal' ? 'declared' : sort

  const counts = useMemo(() => {
    let list = summary.counts
    if (hideEmptyChoices) list = list.filter((c) => c.count > 0)
    list = sortCounts(list, effectiveSort)
    return capCounts(list, maxChoices, t('survey.others'))
  }, [summary.counts, hideEmptyChoices, effectiveSort, maxChoices, t])

  const questionText = title || pickText(question.label, lang) || question.name
  const resolved = resolveColor(color)

  const header = (
    <div className="flex shrink-0 items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {showQuestionText && (
          <p
            className={cn('font-medium leading-snug text-foreground/90', compact ? 'text-xs' : 'text-sm')}
            title={questionText}
          >
            {questionText}
          </p>
        )}
        {question.relevant && (
          // The question was only asked on a branch, so its denominator is that
          // branch — say so rather than letting the reader assume the full sample.
          <p className="mt-0.5 text-[10px] italic text-muted-foreground">
            {t('survey.conditional_question')}
          </p>
        )}
      </div>
      {showResponseRate && (
        <ResponseRate summary={summary} compact={compact} hex={resolved.hex} />
      )}
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
          />
        )
      case 'histogram':
        return (
          <Histogram
            values={providedValues ?? numericValues(question, rows)}
            bins={bins}
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
        return <AnswerList counts={counts} summary={summary} hex={resolved.hex} />
      case 'table':
        return <CountsTable counts={counts} valueLabel={valueLabel} hex={resolved.hex} />
      default:
        return <Empty text={t('survey.no_chart')} />
    }
  })()

  // A multiple-choice question's percentages are over respondents and may sum
  // past 100% — stated on the block, never left to a footnote.
  const footnote =
    question.kind === 'select_multiple' && summary.selections !== undefined
      ? t('survey.multi_footnote', { mean: (summary.meanSelections ?? 0).toFixed(1) })
      : null

  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-2', compact ? 'p-3' : 'p-4')}>
      {header}
      <div className="min-h-0 flex-1">{body}</div>
      {footnote && (
        <p className="shrink-0 text-[10px] leading-snug text-muted-foreground">{footnote}</p>
      )}
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
}: {
  counts: AnswerCount[]
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
  hex: string
  compact?: boolean
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
          <div className={cn('w-full overflow-hidden rounded-sm bg-muted', compact ? 'h-1.5' : 'h-2')}>
            <div
              className="h-full rounded-sm transition-all"
              style={{ width: `${(c.count / top) * 100}%`, backgroundColor: hex, opacity: 0.75 }}
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
}: {
  counts: AnswerCount[]
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
  hex: string
  showGrid: boolean
  compact?: boolean
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
          tick={<TruncatedTick maxLen={compact ? 8 : 14} angle={-25} textAnchor="end" dy={8} />}
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
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(value: unknown, _n: unknown, item: unknown) => {
            const p = (item as { payload?: AnswerCount })?.payload
            return [formatValue(Number(value), p?.proportion ?? 0, 'both'), '']
          }}
        />
        <Bar dataKey="value" fill={hex} fillOpacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false}>
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
}: {
  counts: AnswerCount[]
  donut: boolean
  palette: string
  compact?: boolean
}) {
  const colors = resolvePalette(palette)
  const total = counts.reduce((s, c) => s + c.count, 0)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie
          data={counts}
          dataKey="count"
          nameKey="label"
          cx={compact ? '50%' : '38%'}
          innerRadius={donut ? '48%' : 0}
          outerRadius="82%"
          paddingAngle={counts.length > 1 ? 1.5 : 0}
          strokeWidth={0}
          isAnimationActive={false}
          label={false}
        >
          {counts.map((c, i) => (
            <Cell key={c.code} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(value: unknown, name: unknown) => [
            `${Number(value)} (${total ? ((Number(value) / total) * 100).toFixed(0) : 0}%)`,
            String(name),
          ]}
        />
        {!compact && (
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            wrapperStyle={{
              fontSize: 10,
              lineHeight: 1.4,
              maxWidth: '42%',
              maxHeight: '100%',
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          />
        )}
      </PieChart>
    </ResponsiveContainer>
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
}: {
  values: number[]
  bins: number
  showMedian: boolean
  median?: number
  hex: string
  showGrid: boolean
  compact?: boolean
}) {
  const data = useMemo(() => {
    if (values.length === 0) return []
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (min === max) return [{ label: String(min), value: values.length, start: min }]
    // Sturges' rule when the caller does not pick a bin count.
    const count = bins > 0 ? bins : Math.min(20, Math.ceil(Math.log2(values.length) + 1))
    const width = (max - min) / count
    const buckets = Array.from({ length: count }, (_, i) => ({
      start: min + i * width,
      value: 0,
      label: '',
    }))
    for (const v of values) {
      const idx = Math.min(count - 1, Math.floor((v - min) / width))
      buckets[idx].value++
    }
    for (const b of buckets) {
      b.label = Number.isInteger(width) ? String(Math.round(b.start)) : b.start.toFixed(1)
    }
    return buckets
  }, [values, bins])

  const scale = niceTicks([0, Math.max(...data.map((d) => d.value), 1)], true)

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap={1}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} vertical={false} />}
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          height={compact ? 20 : 24}
          tick={<TruncatedTick maxLen={compact ? 6 : 10} />}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          domain={scale?.domain}
          ticks={scale?.ticks}
          tick={<TruncatedNumericTick formatter={formatCount} />}
        />
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey="value" fill={hex} fillOpacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        {showMedian && median !== undefined && data.length > 1 && (
          <ReferenceLine
            x={
              data.reduce(
                (best, b) => (Math.abs(b.start - median) < Math.abs(best.start - median) ? b : best),
                data[0],
              ).label
            }
            stroke="var(--color-destructive)"
            strokeDasharray="4 3"
            label={{ value: `~${round(median)}`, position: 'top', fontSize: 9, fill: 'var(--color-destructive)' }}
          />
        )}
      </BarChart>
    </ResponsiveContainer>
  )
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
}: {
  counts: AnswerCount[]
  summary: QuestionSummary
  hex: string
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
        <RankedBars counts={repeated} valueLabel="both" hex={hex} compact />
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
