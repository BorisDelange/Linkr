/**
 * Turning questionnaire answers into the numbers a chart shows.
 *
 * This is the module that a generic plot builder cannot replace. Counting
 * answers looks trivial until the denominators are taken seriously, and they
 * differ per question type:
 *
 * - single choice: one column, one answer per respondent. Percentages are over
 *   the respondents who ANSWERED, not over all rows — blanks are non-response,
 *   a distinct fact that gets its own indicator rather than a silent zero.
 * - multiple choice: several 0/1 columns, and a respondent who ticked three
 *   boxes contributes three counts but is ONE respondent. The percentages are
 *   over respondents, so they legitimately sum past 100%. A row where every box
 *   is 0 may mean "answered, chose nothing" or "never saw the question"; the two
 *   are indistinguishable in the data, so the respondent count is defined as
 *   those with at least one tick — and stated as such in the UI.
 * - numeric: non-response is a blank, and summary statistics ignore it.
 *
 * Getting this wrong silently understates or overstates every percentage in a
 * report, which is why it lives here, is pure, and is tested.
 */

import type { SurveyQuestion, SurveySchema } from './survey-schema'
import { questionChoices, questionColumns, choiceColumn } from './survey-schema'

/** Pick a language's text from a localized label, falling back to any entry. */
function text(label: Record<string, string> | undefined, lang: string): string {
  if (!label) return ''
  return label[lang] ?? Object.values(label)[0] ?? ''
}

/** One bar/slice: a choice, how many picked it, and over which denominator. */
export interface AnswerCount {
  code: string
  label: string
  count: number
  /** `count / respondents`, in 0..1. NaN-free: 0 when there are no respondents. */
  proportion: number
}

export interface QuestionSummary {
  /** Rows considered (the whole dataset, or the active filter's subset). */
  total: number
  /** Respondents who gave this question an answer. The percentage denominator. */
  respondents: number
  /** `total - respondents`. */
  missing: number
  /** Respondents who answered, over the rows considered, in 0..1. */
  responseRate: number
  /** Per-choice counts, for categorical questions. Empty for numeric/text. */
  counts: AnswerCount[]
  /** For `multi`: total ticks across respondents (counts sum). */
  selections?: number
  /** For `multi`: mean number of ticks per responding respondent. */
  meanSelections?: number
  /** Set for numeric questions. */
  stats?: NumericStats
  /** For free text: how many DISTINCT answers were given. Close to
   *  `respondents` means everyone wrote something different; much lower means
   *  the column is a category list nobody coded. */
  distinctAnswers?: number
}

export interface NumericStats {
  n: number
  min: number
  max: number
  mean: number
  median: number
  q1: number
  q3: number
  sum: number
  /** Sample standard deviation (n-1). 0 when n < 2. */
  sd: number
}

/** A cell counts as missing when it is null/undefined or blank after trimming. */
export function isBlank(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

/**
 * Whether a one-hot cell reads as ticked. Exports disagree on the truthy token
 * (`1`, `"1"`, `true`, `"Checked"`, `"Yes"`), so accept the common spellings
 * rather than trusting a single one.
 */
export function isTicked(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    // `y` is LimeSurvey's own ticked value. Note 2 is deliberately NOT ticked:
    // with its "convert Y/N" export option on, 1 means yes but **2 means no**,
    // so a "non-zero is ticked" rule would read every No as a Yes.
    return v === '1' || v === 'y' || v === 'true' || v === 'checked' || v === 'yes' || v === 'oui'
  }
  return false
}

/** Parse a cell as a finite number, or null when it isn't one. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    // Tolerate the decimal comma, which French exports produce.
    const n = Number(trimmed.replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Summarise one question over `rows`.
 *
 * `rows` are keyed by dataset column name, matching `question.columns`.
 */
export function summarizeQuestion(
  schema: SurveySchema,
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
  lang = 'fr',
): QuestionSummary {
  const total = rows.length
  switch (question.kind) {
    case 'select_multiple':
      return summarizeMulti(schema, question, rows, total, lang)
    case 'integer':
    case 'decimal':
      return summarizeNumeric(question, rows, total)
    case 'text':
    case 'date':
    case 'datetime':
      return summarizeText(question, rows, total)
    default:
      return summarizeSingle(schema, question, rows, total, lang)
  }
}

function emptySummary(total: number): QuestionSummary {
  return { total, respondents: 0, missing: total, responseRate: 0, counts: [] }
}

function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

/**
 * Single choice (also `scale` and `boolean`): count the distinct values of the
 * one column. Declared choices set the order and supply labels; any value not
 * in the choice list is still reported, so dirty data stays visible.
 */
function summarizeSingle(
  schema: SurveySchema,
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
  total: number,
  lang: string,
): QuestionSummary {
  const column = questionColumns(question)[0]
  if (!column) return emptySummary(total)

  const tally = new Map<string, number>()
  let respondents = 0
  for (const row of rows) {
    const raw = row[column]
    if (isBlank(raw)) continue
    respondents++
    const code = String(raw).trim()
    tally.set(code, (tally.get(code) ?? 0) + 1)
  }

  const counts: AnswerCount[] = []
  const seen = new Set<string>()
  // Declared choices first, in their declared order — a zero-count choice is
  // meaningful ("nobody picked this") and must not vanish from the chart.
  for (const choice of questionChoices(schema, question)) {
    const count = tally.get(choice.name) ?? 0
    seen.add(choice.name)
    counts.push({
      code: choice.name,
      label: text(choice.label, lang) || choice.name,
      count,
      proportion: rate(count, respondents),
    })
  }
  for (const [code, count] of tally) {
    if (seen.has(code)) continue
    counts.push({ code, label: code, count, proportion: rate(count, respondents) })
  }

  return {
    total,
    respondents,
    missing: total - respondents,
    responseRate: rate(respondents, total),
    counts,
  }
}

/**
 * Multiple choice: one 0/1 column per choice. A respondent counts once no
 * matter how many boxes they ticked, so percentages are over respondents and
 * may sum above 100%.
 */
function summarizeMulti(
  schema: SurveySchema,
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
  total: number,
  lang: string,
): QuestionSummary {
  const choices = questionChoices(schema, question)
  if (choices.length === 0) return emptySummary(total)

  const tally = new Array<number>(choices.length).fill(0)
  let respondents = 0
  let selections = 0

  for (const row of rows) {
    let ticksInRow = 0
    choices.forEach((choice, i) => {
      const column = choiceColumn(question, choice.name)
      if (!column) return
      if (isTicked(row[column])) {
        tally[i]++
        ticksInRow++
      }
    })
    if (ticksInRow > 0) {
      respondents++
      selections += ticksInRow
    }
  }

  const counts = choices.map((choice, i) => ({
    code: choice.name,
    label: text(choice.label, lang) || choice.name,
    count: tally[i],
    proportion: rate(tally[i], respondents),
  }))

  return {
    total,
    respondents,
    missing: total - respondents,
    responseRate: rate(respondents, total),
    counts,
    selections,
    meanSelections: rate(selections, respondents),
  }
}

function summarizeNumeric(
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
  total: number,
): QuestionSummary {
  const column = questionColumns(question)[0]
  if (!column) return emptySummary(total)

  const values: number[] = []
  for (const row of rows) {
    const n = toNumber(row[column])
    if (n !== null) values.push(n)
  }

  return {
    total,
    respondents: values.length,
    missing: total - values.length,
    responseRate: rate(values.length, total),
    counts: [],
    stats: describe(values),
  }
}

/**
 * Free text. Counted like a choice question, because a text answer often is one
 * in disguise — a facility name repeated across respondents, a "specify" field
 * where the same handful of answers recur. The counts are the distinct answers
 * by frequency; a column where every answer is unique simply yields a flat list,
 * which is itself the finding.
 */
function summarizeText(
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
  total: number,
): QuestionSummary {
  const column = questionColumns(question)[0]
  if (!column) return emptySummary(total)

  const tally = new Map<string, number>()
  let respondents = 0
  for (const row of rows) {
    const raw = row[column]
    if (isBlank(raw)) continue
    respondents++
    const key = String(raw).trim()
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }

  const counts: AnswerCount[] = [...tally]
    .map(([code, count]) => ({ code, label: code, count, proportion: rate(count, respondents) }))
    .sort((a, b) => b.count - a.count)

  return {
    total,
    respondents,
    missing: total - respondents,
    responseRate: rate(respondents, total),
    counts,
    /** How many answers were given more than once — the signal that a text
     *  column is really a category list that was never coded. */
    distinctAnswers: counts.length,
  }
}

/** Descriptive statistics of a numeric sample. Returns undefined when empty. */
export function describe(values: number[]): NumericStats | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const mean = sum / n
  const variance = n > 1 ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    sum,
    sd: Math.sqrt(variance),
  }
}

/** Linear-interpolation quantile (R type 7) over an ALREADY SORTED sample. */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const pos = (n - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

/**
 * Order counts for display. Frequency order is what a reader wants for an
 * unordered list; declared order is mandatory for a scale, where the codes carry
 * meaning (1..5) and reordering them would destroy the reading.
 */
export type CountSort = 'declared' | 'frequency' | 'alphabetical'

export function sortCounts(counts: AnswerCount[], sort: CountSort): AnswerCount[] {
  const out = [...counts]
  if (sort === 'frequency') out.sort((a, b) => b.count - a.count)
  else if (sort === 'alphabetical') out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

/**
 * Cross a categorical question by a grouping column: counts per (group, choice),
 * each group's percentages over its OWN respondents so groups of unequal size
 * stay comparable.
 */
export interface CrossTab {
  groups: { value: string; label: string; summary: QuestionSummary }[]
}

export function crossTabulate(
  schema: SurveySchema,
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
  groupColumn: string,
  groupLabels?: Record<string, string>,
  lang = 'fr',
): CrossTab {
  const buckets = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const raw = row[groupColumn]
    if (isBlank(raw)) continue
    const key = String(raw).trim()
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, groupRows]) => ({
      value,
      label: groupLabels?.[value] ?? value,
      summary: summarizeQuestion(schema, question, groupRows, lang),
    }))
  return { groups }
}

/**
 * How many respondents ticked exactly k boxes, for k = 0..choices.length.
 *
 * This is the diagnostic that makes every other multiple-choice number
 * readable: it separates respondents who engaged with the question from those
 * who ticked one box and moved on, and it exposes the differential selection
 * depth that silently inflates one group's bars when comparing groups. Index k
 * of the result is the number of respondents with k selections.
 */
export function selectionCountDistribution(
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
): number[] {
  const columns = oneHotColumns(question)
  const distribution = new Array<number>(columns.length + 1).fill(0)
  for (const row of rows) {
    let ticks = 0
    for (const column of columns) if (isTicked(row[column])) ticks++
    distribution[ticks]++
  }
  return distribution
}

/** The 0/1 columns of a multiple-choice question, in choice order. Empty for a
 *  question that is not one-hot bound (nothing to co-analyse). */
function oneHotColumns(question: SurveyQuestion): string[] {
  return question.binding.kind === 'one_hot'
    ? question.binding.columns.map((c) => c.column)
    : []
}

/**
 * How often each pair of choices was ticked together, for a `multi` question.
 * Co-selection is the question a one-hot bar chart cannot answer ("who picks
 * both ECMO and SMUR?"), and it is the main reason a generic plot builder falls
 * short on multiple choice.
 *
 * Returns a square matrix in `choices` order; the diagonal is each choice's own
 * count.
 */
export function coSelectionMatrix(
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
): number[][] {
  const columns = oneHotColumns(question)
  const size = columns.length
  const matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  for (const row of rows) {
    const ticked: number[] = []
    columns.forEach((column, i) => {
      if (isTicked(row[column])) ticked.push(i)
    })
    for (const i of ticked) {
      for (const j of ticked) matrix[i][j]++
    }
  }
  return matrix
}

/**
 * Jaccard similarity between every pair of choices: of the respondents who
 * ticked either box, the share who ticked both.
 *
 * Raw co-selection counts mechanically favour popular choices — two options
 * everyone picks co-occur constantly without being related. Jaccard normalises
 * that away, which is why it is the standard measure for binary multi-response
 * data. It ignores respondents who ticked neither, deliberately: with a dozen
 * options that group dominates and would make every pair look similar.
 *
 * The diagonal is 1 for any choice someone ticked, and 0 for one nobody did.
 */
export function jaccardMatrix(
  question: SurveyQuestion,
  rows: Record<string, unknown>[],
): number[][] {
  const co = coSelectionMatrix(question, rows)
  return co.map((row, i) =>
    row.map((both, j) => {
      // |A ∪ B| = |A| + |B| - |A ∩ B|, with the counts on the diagonal.
      const union = co[i][i] + co[j][j] - both
      return union > 0 ? both / union : 0
    }),
  )
}
