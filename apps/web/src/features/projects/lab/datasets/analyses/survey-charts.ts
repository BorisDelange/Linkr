/**
 * Which chart fits which question type.
 *
 * Kept out of the component file so both the block and its dashboard wrapper can
 * import them without tripping fast-refresh (a module exporting components must
 * export nothing else).
 *
 * The rules come from docs/planning/survey-plugin-plan.md §3.2. The one that is
 * structural rather than stylistic: a pie or a 100%-stacked chart asserts a
 * part-to-whole relationship, which a multiple-choice question does not have —
 * one respondent can tick several boxes — so those charts are absent from its
 * list by construction.
 */

import type { SurveyQuestion } from '@/lib/survey/survey-schema'

/** The charts a question can be drawn as. `auto` picks by question type. */
export type SurveyChart =
  | 'auto'
  | 'bar'
  | 'column'
  | 'pie'
  | 'donut'
  | 'histogram'
  | 'stats'
  | 'table'
  /** Free text: the most frequent answers, with a sample of the rest. */
  | 'answers'

/** The chart a question gets when none is forced. */
export function defaultChart(question: SurveyQuestion): SurveyChart {
  switch (question.kind) {
    case 'select_multiple':
    case 'select_one':
    case 'range':
      return 'bar'
    case 'integer':
    case 'decimal':
      return 'histogram'
    default:
      // Free text still has a distribution worth seeing — repeated answers, the
      // long tail of one-offs. Two summary numbers in the middle of an empty
      // panel say almost nothing.
      return 'answers'
  }
}

/** The charts offered for this question; anything else falls back to `auto`. */
export function availableCharts(question: SurveyQuestion): SurveyChart[] {
  switch (question.kind) {
    case 'select_multiple':
      return ['auto', 'bar', 'column', 'table']
    case 'select_one':
    case 'range':
      return ['auto', 'bar', 'column', 'pie', 'donut', 'table']
    case 'integer':
    case 'decimal':
      // No `table`: the counts table lists a question's CHOICES, and a numeric
      // question has none — it rendered as an empty table.
      return ['auto', 'histogram', 'stats']
    default:
      // Free text has no numeric summary to speak of, so no `stats`; `bar`
      // works because the answers are tallied like choices.
      return ['auto', 'answers', 'bar', 'table']
  }
}
