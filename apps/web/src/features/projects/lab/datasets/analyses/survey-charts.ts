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
      return 'stats'
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
      return ['auto', 'histogram', 'stats', 'table']
    default:
      return ['auto', 'stats', 'table']
  }
}
