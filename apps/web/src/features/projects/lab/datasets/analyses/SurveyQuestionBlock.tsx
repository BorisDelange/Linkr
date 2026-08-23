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
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
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

/**
 * n/N with a filled bar — the response-rate indicator every slide of the source
 * report carries. Non-response is a finding, not a footnote.
 */
function ResponseRate({ summary, compact }: { summary: QuestionSummary; compact?: boolean }) {
  const { t } = useTranslation()
  const pct = Math.round(summary.responseRate * 100)
  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <span className="whitespace-nowrap">
        {summary.respondents}/{summary.total} ({pct}%)
      </span>
      <span className={cn('flex overflow-hidden rounded-full', compact ? 'h-1 w-12' : 'h-1.5 w-16')}>
        <span className="h-full bg-primary" style={{ width: `${pct}%` }} />
        <span className="h-full bg-destructive/40" style={{ width: `${100 - pct}%` }} />
      </span>
      <span className="sr-only">{t('survey.respondents')}</span>
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
    <div className={cn('flex items-start justify-between gap-3', compact ? 'px-3 pt-2' : 'mb-2')}>
      <div className="min-w-0 flex-1">
        {showQuestionText && (
          <p className={cn('font-medium text-foreground/90', compact ? 'text-xs' : 'text-sm')}>
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
      case 'column':
        return (
          <CategoryChart
            counts={counts}
            horizontal={effectiveChart === 'bar'}
            valueLabel={valueLabel}
            hex={resolved.hex}
            compact={compact}
          />
        )
      case 'pie':
      case 'donut':
        return (
          <SharePie counts={counts} donut={effectiveChart === 'donut'} palette={palette} compact={compact} />
        )
      case 'histogram':
        return (
          <Histogram
            values={providedValues ?? numericValues(question, rows)}
            bins={bins}
            showMedian={showMedian}
            median={summary.stats?.median}
            hex={resolved.hex}
            compact={compact}
          />
        )
      case 'stats':
        return <Stats summary={summary} />
      case 'table':
        return <CountsTable counts={counts} valueLabel={valueLabel} />
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
    <div className={cn('flex h-full min-h-0 flex-col', compact ? '' : 'gap-1')}>
      {header}
      <div className={cn('min-h-0 flex-1', compact ? 'px-2 pb-2' : '')}>{body}</div>
      {footnote && (
        <p className={cn('text-[10px] text-muted-foreground', compact ? 'px-3 pb-2' : '')}>
          {footnote}
        </p>
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

/**
 * Sorted bars with `n (pct%)` at the end — the workhorse, and what the source
 * report uses for both single and multiple choice.
 */
function CategoryChart({
  counts,
  horizontal,
  valueLabel,
  hex,
  compact,
}: {
  counts: AnswerCount[]
  horizontal: boolean
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
  hex: string
  compact?: boolean
}) {
  const data = counts.map((c) => ({ ...c, value: c.count }))
  const label = (entry: AnswerCount) => formatValue(entry.count, entry.proportion, valueLabel)

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={
          horizontal
            ? { top: 4, right: 56, bottom: 4, left: 4 }
            : { top: 16, right: 8, bottom: 4, left: 4 }
        }
      >
        {horizontal ? (
          <>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              width={compact ? 110 : 160}
              tickLine={false}
              axisLine={false}
              interval={0}
              tick={<TruncatedTick maxLen={compact ? 18 : 28} textAnchor="end" dx={-4} dy={3} />}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              interval={0}
              tick={<TruncatedTick maxLen={compact ? 10 : 16} />}
            />
            <YAxis type="number" tick={<TruncatedNumericTick formatter={(v) => String(v)} />} tickLine={false} axisLine={false} width={36} />
          </>
        )}
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey="value" fill={hex} radius={2} isAnimationActive={false}>
          {valueLabel !== 'none' && (
            <LabelList
              dataKey="label"
              position={horizontal ? 'right' : 'top'}
              content={(props: {
                x?: string | number
                y?: string | number
                width?: string | number
                height?: string | number
                index?: number
              }) => {
                const entry = data[props.index ?? 0]
                if (!entry) return null
                const num = (v: string | number | undefined) => (typeof v === 'number' ? v : Number(v ?? 0))
                const w = num(props.width)
                const h = num(props.height)
                const x = num(props.x) + (horizontal ? w + 4 : w / 2)
                const y = num(props.y) + (horizontal ? h / 2 + 3 : -4)
                return (
                  <text
                    x={x}
                    y={y}
                    fontSize={10}
                    fill="currentColor"
                    className="fill-muted-foreground"
                    textAnchor={horizontal ? 'start' : 'middle'}
                  >
                    {label(entry)}
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

/** Pie / donut — only offered for single choice, where the parts are a whole. */
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
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={counts}
          dataKey="count"
          nameKey="label"
          innerRadius={donut ? '45%' : 0}
          outerRadius="80%"
          isAnimationActive={false}
          label={compact ? false : (e: { name?: string }) => e.name ?? ''}
        >
          {counts.map((c, i) => (
            <Cell key={c.code} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Tooltip {...TOOLTIP_STYLE} />
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
  compact,
}: {
  values: number[]
  bins: number
  showMedian: boolean
  median?: number
  hex: string
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

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          tick={<TruncatedTick maxLen={compact ? 6 : 10} />}
        />
        <YAxis tick={<TruncatedNumericTick formatter={(v) => String(v)} />} tickLine={false} axisLine={false} width={32} />
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey="value" fill={hex} radius={2} isAnimationActive={false} />
        {showMedian && median !== undefined && data.length > 1 && (
          <ReferenceLine
            x={data.reduce((best, b) => (Math.abs(b.start - median) < Math.abs(best.start - median) ? b : best), data[0]).label}
            stroke="var(--color-destructive)"
            strokeDasharray="4 3"
          />
        )}
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Descriptive statistics, for a numeric question or as a text question's fallback. */
function Stats({ summary }: { summary: QuestionSummary }) {
  const { t } = useTranslation()
  const s = summary.stats
  const entries: [string, string][] = s
    ? [
        [t('survey.stat_n'), String(s.n)],
        [t('survey.stat_median'), `${round(s.median)} [${round(s.q1)} – ${round(s.q3)}]`],
        [t('survey.stat_mean'), `${round(s.mean)} ± ${round(s.sd)}`],
        [t('survey.stat_range'), `${round(s.min)} – ${round(s.max)}`],
        [t('survey.stat_sum'), String(round(s.sum))],
      ]
    : [
        [t('survey.stat_respondents'), String(summary.respondents)],
        [t('survey.stat_missing'), String(summary.missing)],
      ]
  return (
    <div className="grid h-full grid-cols-2 content-center gap-x-4 gap-y-1 p-3 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{k}</span>
          <span className="font-medium tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  )
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function CountsTable({
  counts,
  valueLabel,
}: {
  counts: AnswerCount[]
  valueLabel: NonNullable<SurveyQuestionBlockProps['valueLabel']>
}) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <tbody>
          {counts.map((c) => (
            <tr key={c.code} className="border-b border-border/50 last:border-0">
              <td className="py-1 pr-2">{c.label}</td>
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
