/**
 * Build the survey-question render SPEC sent to POST /execute/render.
 *
 * A render is a VIEW a plain viewer can trigger, so the client must never send
 * code — only a validated spec. The server holds the pandas program
 * (apps/api/app/services/execution/render/survey_question.py) and must produce
 * the same `QuestionSummary` shape the client computes locally, so the same
 * component renders either way.
 *
 * The spec carries the QUESTION, not just a column, because that is the part a
 * bare table cannot express: which columns belong together, which code each
 * one-hot column stands for, and in which order the choices were declared. It
 * is small — one question, not the schema — and travels by column NAME, since
 * the server sees the dataset's real column names.
 */

import type { DatasetColumn } from '@/types'
import {
  questionChoices,
  type SurveyQuestion,
  type SurveySchema,
} from '@/lib/survey/survey-schema'

export interface SurveyQuestionSpec {
  /** What kind of summary to compute. Mirrors the client's switch. */
  kind: 'select_one' | 'select_multiple' | 'numeric' | 'text'
  /** Choices in DECLARED order, with the column each one lives in for a
   *  multiple-choice question. Order matters: a scale must not be re-sorted. */
  choices: { code: string; label: string; column?: string }[]
  /** The single column, for everything that is not one-hot. */
  column: string | null
}

/** The label to show for a choice, in the requested language. */
function pickText(label: Record<string, string> | undefined, lang: string): string {
  if (!label) return ''
  return label[lang] ?? label.fr ?? label.en ?? label.und ?? Object.values(label)[0] ?? ''
}

/**
 * @param columns  the dataset's columns, to map internal ids back to the real
 *                 column names the server queries by
 */
export function buildSurveyQuestionSpec(
  schema: SurveySchema,
  question: SurveyQuestion,
  columns: DatasetColumn[],
  lang: string,
): SurveyQuestionSpec {
  const nameById = new Map(columns.map((c) => [c.id, c.name]))
  const toName = (id: string) => nameById.get(id) ?? id

  if (question.binding.kind === 'one_hot') {
    const byCode = new Map(question.binding.columns.map((c) => [c.code, c.column]))
    return {
      kind: 'select_multiple',
      choices: questionChoices(schema, question).map((c) => ({
        code: c.name,
        label: pickText(c.label, lang) || c.name,
        column: toName(byCode.get(c.name) ?? ''),
      })),
      column: null,
    }
  }

  // `delimited` is expanded to one_hot at import, so anything left is a single
  // column: a choice question, a number, or free text.
  const column = toName(question.binding.column)

  if (question.kind === 'integer' || question.kind === 'decimal') {
    return { kind: 'numeric', choices: [], column }
  }
  if (question.kind === 'select_one' || question.kind === 'range') {
    return {
      kind: 'select_one',
      choices: questionChoices(schema, question).map((c) => ({
        code: c.name,
        label: pickText(c.label, lang) || c.name,
      })),
      column,
    }
  }
  return { kind: 'text', choices: [], column }
}
