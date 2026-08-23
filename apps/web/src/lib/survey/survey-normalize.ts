/**
 * Bring any imported questionnaire to the ONE stored shape: a plain wide table
 * with one 0/1 column per multiple-choice option.
 *
 * Importers describe what the source file looked like (`binding`); this module
 * rewrites the rows so that everything downstream — the datatable, filters, the
 * plugin — sees the same thing whatever tool the answers came from.
 *
 * Why one-hot rather than keeping the source shape: a delimited cell reading
 * `usic usinv usih` cannot be read at a glance, cannot be filtered, and cannot
 * be counted without re-parsing it every time. One column per option is the
 * only shape that is both analysable and legible in the Datasets datatable,
 * which is where a broken import is actually noticed.
 *
 * Goupile and REDCap are already one-hot, so for them this is a no-op and no
 * column is added. Only the delimited sources (ODK/XLSForm, Qualtrics,
 * OpenClinica, Castor's API) expand.
 */

import type { SurveyChoice, SurveyQuestion, SurveySchema } from './survey-schema'

/** The value written into an expanded one-hot column. */
const TICKED = 1
const UNTICKED = 0

export interface NormalizeResult {
  /** Column names in order, with expansions inserted where the source column was. */
  columns: string[]
  rows: Record<string, unknown>[]
  /** The schema with every `delimited` binding rewritten to `one_hot`. */
  schema: SurveySchema
}

/**
 * The column name for one option of an expanded question. Mirrors ODK's own
 * `question/choice` convention rather than inventing a separator, so a re-import
 * of what we wrote lands on the same names.
 */
export function expandedColumnName(question: string, code: string): string {
  return `${question}/${code}`
}

/** Split a delimited cell into the codes it holds. */
export function splitDelimited(value: unknown, separator: string): string[] {
  if (value == null) return []
  const raw = String(value).trim()
  if (raw === '') return []
  // A space separator must tolerate runs of whitespace; others are literal.
  const parts = separator === ' ' ? raw.split(/\s+/) : raw.split(separator)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

/**
 * Rewrite delimited multi-select columns into one 0/1 column per choice.
 *
 * Rows that name a code absent from the choice list keep it: an unexpected code
 * is a data problem worth seeing, not one to swallow, so it gets its own column
 * and is appended to the question's choice list.
 */
export function normalizeSurvey(
  schema: SurveySchema,
  columns: string[],
  rows: Record<string, unknown>[],
): NormalizeResult {
  const delimited = schema.questions.filter((q) => q.binding.kind === 'delimited')
  if (delimited.length === 0) return { columns, rows, schema }

  const choices: Record<string, SurveyChoice[]> = { ...schema.choices }
  const questions: SurveyQuestion[] = []
  // sourceColumn → how to expand it: the separator it used and the columns
  // replacing it, in choice order.
  const expansions = new Map<
    string,
    { separator: string; columns: { code: string; column: string }[] }
  >()

  for (const question of schema.questions) {
    if (question.binding.kind !== 'delimited') {
      questions.push(question)
      continue
    }
    const source = question.binding.column
    const separator = question.binding.separator
    const listName = question.listName ?? question.name
    const list = [...(choices[listName] ?? [])]

    // Any code present in the data but missing from the declared list.
    const known = new Set(list.map((c) => c.name))
    for (const row of rows) {
      for (const code of splitDelimited(row[source], separator)) {
        if (known.has(code)) continue
        known.add(code)
        list.push({ name: code, label: { und: code } })
      }
    }

    const oneHot = list.map((c) => ({
      code: c.name,
      column: expandedColumnName(question.name, c.name),
    }))
    expansions.set(source, { separator, columns: oneHot })
    choices[listName] = list
    questions.push({ ...question, listName, binding: { kind: 'one_hot', columns: oneHot } })
  }

  // Rebuild the column list, replacing each source column in place so the
  // questionnaire's reading order survives.
  const nextColumns: string[] = []
  for (const column of columns) {
    const expanded = expansions.get(column)
    if (expanded) nextColumns.push(...expanded.columns.map((e) => e.column))
    else nextColumns.push(column)
  }

  const nextRows = rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const column of columns) {
      const expanded = expansions.get(column)
      if (!expanded) {
        out[column] = row[column]
        continue
      }
      const selected = new Set(splitDelimited(row[column], expanded.separator))
      // A blank cell is a non-answer, not "nothing selected": leave the whole
      // group null so the plugin can tell the two apart.
      const answered = selected.size > 0
      for (const { code, column: target } of expanded.columns) {
        out[target] = answered ? (selected.has(code) ? TICKED : UNTICKED) : null
      }
    }
    return out
  })

  return { columns: nextColumns, rows: nextRows, schema: { ...schema, questions, choices } }
}
