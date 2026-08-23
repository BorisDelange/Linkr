/**
 * Recover a `SurveySchema` from a dataset's columns alone.
 *
 * A widget only ever receives `columns` + `rows`, never the import-time schema,
 * so the questionnaire structure has to be re-derived at render time. That turns
 * out to be a feature rather than a workaround: it makes the questionnaire
 * plugin work on ANY wide dataset — a plain CSV of answers, a hand-built export,
 * a tool we have no importer for — not only on the two we parse natively.
 *
 * The signal comes from the column metadata the importers already persist
 * (`label`, `description`, `valueLabels`) plus the one-hot NAMING conventions,
 * which are the load-bearing part: `q___code` (REDCap) and `q.code` (Goupile)
 * both say "these columns are one question".
 */

import type { DatasetColumn } from '@/types'
import type { SurveyChoice, SurveyQuestion, SurveySchema, QuestionKind } from './survey-schema'
import { isTicked, toNumber, isBlank } from './survey-analysis'

/** The separators one-hot exports use between a question and its choice code. */
const ONE_HOT_SEPARATORS = ['___', '.'] as const

/** Columns that are bookkeeping rather than answers. */
const SYSTEM_COLUMNS = new Set(['__tid', '__sequence', '__hid'])

function isSystemColumn(name: string): boolean {
  return (
    SYSTEM_COLUMNS.has(name) ||
    name.endsWith('_complete') ||
    name.endsWith('_timestamp') ||
    name === 'redcap_event_name'
  )
}

/** Split `usi___usic` / `usi.usic` into its question and choice parts. */
function splitOneHot(name: string): { parent: string; code: string } | null {
  for (const sep of ONE_HOT_SEPARATORS) {
    const at = name.indexOf(sep)
    // A separator at position 0 would leave an empty parent.
    if (at > 0) {
      const parent = name.slice(0, at)
      const code = name.slice(at + sep.length)
      if (parent && code && !code.includes(sep)) return { parent, code }
    }
  }
  return null
}

/**
 * Does this column hold only 0/1-ish values? A one-hot group is only real when
 * its members are flags — `adresse.rue` and `adresse.ville` share a prefix but
 * are plainly not a multiple-choice question.
 */
function looksBinary(column: DatasetColumn, rows: Record<string, unknown>[]): boolean {
  let seen = 0
  for (const row of rows) {
    const raw = row[column.id]
    if (isBlank(raw)) continue
    seen++
    if (isTicked(raw)) continue
    const n = toNumber(raw)
    if (n === 0) continue
    if (typeof raw === 'boolean') continue
    const v = String(raw).trim().toLowerCase()
    if (v === '0' || v === 'false' || v === 'unchecked' || v === 'no' || v === 'non') continue
    return false
  }
  return seen > 0
}

/** Distinct non-blank values of a column, capped — beyond the cap it is not a
 *  categorical question but free text or an identifier. */
function distinctValues(
  column: DatasetColumn,
  rows: Record<string, unknown>[],
  cap: number,
): string[] | null {
  const set = new Set<string>()
  for (const row of rows) {
    const raw = row[column.id]
    if (isBlank(raw)) continue
    set.add(String(raw).trim())
    if (set.size > cap) return null
  }
  return [...set]
}

/**
 * The analytical type of a single (non-one-hot) column.
 *
 * Declared `valueLabels` are trusted outright — they exist precisely because an
 * importer knew the question was categorical. Otherwise the type is inferred
 * from the values, which is why `rows` are needed.
 */
function inferSingleType(
  column: DatasetColumn,
  rows: Record<string, unknown>[],
  maxCategories: number,
): { kind: QuestionKind; measure?: SurveyQuestion['measure']; choices?: SurveyChoice[] } {
  const valueLabels = column.valueLabels
  if (valueLabels && Object.keys(valueLabels).length > 0) {
    const choices = Object.entries(valueLabels).map(([code, label]) => ({
      name: code,
      label: { und: label },
    }))
    return {
      kind: 'select_one',
      measure: looksLikeScale(choices) ? 'ordinal' : 'nominal',
      choices,
    }
  }

  if (column.type === 'date') return { kind: 'date' }

  if (column.type === 'number') {
    // A column holding only 0 and 1 is a yes/no answer, not a quantity — the
    // mean of a 0/1 column is a proportion, and charting it as a histogram
    // says nothing a two-bar chart wouldn't say better.
    const binary = distinctValues(column, rows, 2)
    if (binary && binary.length > 0 && binary.every((v) => v === '0' || v === '1')) {
      return {
        kind: 'select_one',
        measure: 'nominal',
        choices: [
          { name: '1', label: { en: 'Yes', fr: 'Oui' } },
          { name: '0', label: { en: 'No', fr: 'Non' } },
        ],
      }
    }
    // A numeric column with very few distinct values is a coded scale, not a
    // measurement: a 1–5 satisfaction must not be charted as a histogram of a
    // continuous quantity.
    const values = distinctValues(column, rows, maxCategories)
    if (values && values.length >= 3 && values.length <= 7) {
      const choices = values
        .map((v) => ({ name: v, label: { und: v }, sort: Number(v) }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ name, label }) => ({ name, label }))
      if (looksLikeScale(choices)) return { kind: 'select_one', measure: 'ordinal', choices }
    }
    return { kind: 'decimal', measure: 'continuous' }
  }

  if (column.type === 'boolean') {
    return {
      kind: 'select_one',
      measure: 'nominal',
      choices: [
        { name: 'true', label: { en: 'True', fr: 'Vrai' } },
        { name: 'false', label: { en: 'False', fr: 'Faux' } },
      ],
    }
  }

  const values = distinctValues(column, rows, maxCategories)
  if (!values) return { kind: 'text' }
  // A column where nearly every row is its own value is an identifier or a free
  // comment, whatever its cardinality.
  const answered = rows.filter((r) => !isBlank(r[column.id])).length
  if (answered > 0 && values.length > Math.max(maxCategories / 2, answered * 0.7)) {
    return { kind: 'text' }
  }
  if (values.length === 0) return { kind: 'text' }
  const choices = values
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ name: v, label: { und: v } }))
  return { kind: 'select_one', measure: 'nominal', choices }
}

/** Consecutive integer codes (3+) read as an ordered scale. */
function looksLikeScale(choices: SurveyChoice[]): boolean {
  if (choices.length < 3) return false
  const nums = choices.map((c) => Number(c.name))
  if (nums.some((n) => !Number.isInteger(n))) return false
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1)
}

export interface InferOptions {
  /** Above this many distinct values a string column is free text, not a choice
   *  list. Deliberately generous: a French region list is already 14. */
  maxCategories?: number
}

/**
 * Build a schema from the dataset itself.
 *
 * One-hot groups are detected first (they consume several columns), then every
 * remaining column becomes a single question.
 */
export function inferSurveySchema(
  columns: DatasetColumn[],
  rows: Record<string, unknown>[],
  options: InferOptions = {},
): SurveySchema {
  const maxCategories = options.maxCategories ?? 30

  // Group candidate one-hot columns by their parent name, preserving order.
  const groups = new Map<string, { column: DatasetColumn; code: string }[]>()
  for (const column of columns) {
    if (isSystemColumn(column.name)) continue
    const split = splitOneHot(column.name)
    if (!split) continue
    const list = groups.get(split.parent)
    if (list) list.push({ column, code: split.code })
    else groups.set(split.parent, [{ column, code: split.code }])
  }

  const consumed = new Set<string>()
  const questions: SurveyQuestion[] = []
  const choiceLists: Record<string, SurveyChoice[]> = {}

  for (const [parent, members] of groups) {
    // A single member is not a choice list — it is just a dotted column name.
    if (members.length < 2) continue
    if (!members.every((m) => looksBinary(m.column, rows))) continue

    // The importers put the option text in the one-hot column's own label.
    choiceLists[parent] = members.map(({ column, code }) => ({
      name: code,
      label: { und: column.label ?? code },
    }))
    for (const m of members) consumed.add(m.column.id)

    questions.push({
      name: parent,
      kind: 'select_multiple',
      listName: parent,
      // All members share the parent question, carried as their description.
      label: { und: members[0].column.description ?? humanizeName(parent) },
      shortLabel: humanizeName(parent),
      measure: 'nominal',
      binding: {
        kind: 'one_hot',
        columns: members.map((m) => ({ code: m.code, column: m.column.id })),
      },
    })
  }

  for (const column of columns) {
    if (consumed.has(column.id)) continue
    if (isSystemColumn(column.name)) continue
    const { kind, measure, choices } = inferSingleType(column, rows, maxCategories)
    if (choices) choiceLists[column.id] = choices
    questions.push({
      name: column.id,
      kind,
      ...(choices ? { listName: column.id } : {}),
      // The importers store the full question in `description` and a short name
      // in `label`; fall back to the column name when neither is set.
      label: { und: column.description ?? column.label ?? column.name },
      shortLabel: column.label ?? humanizeName(column.name),
      ...(measure ? { measure } : {}),
      binding: { kind: 'single_column', column: column.id },
    })
  }

  // Keep the dataset's own column order so the questionnaire reads in the order
  // it was asked.
  const position = new Map(columns.map((c, i) => [c.id, i]))
  const firstColumn = (q: SurveyQuestion) =>
    q.binding.kind === 'one_hot' ? q.binding.columns[0]?.column : q.binding.column
  questions.sort((a, b) => (position.get(firstColumn(a)) ?? 0) - (position.get(firstColumn(b)) ?? 0))

  const respondentId = columns.find((c) => c.name === '__tid' || c.name === 'record_id')
  return {
    source: 'generic',
    questions,
    choices: choiceLists,
    ...(respondentId ? { respondentIdColumn: respondentId.id } : {}),
  }
}

function humanizeName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
