/**
 * XLSForm import: read a `survey` + `choices` workbook into a `SurveySchema`.
 *
 * This is the shortest importer of the three, because XLSForm IS our model —
 * the mapping is nearly one-to-one. It is also the widest in reach: ODK,
 * KoboToolbox, SurveyCTO, Ona and OpenClinica 4 all author forms this way, so
 * one parser covers them.
 *
 * The one real transformation is the binding. ODK stores a `select_multiple`
 * answer as space-separated codes in a SINGLE column (`usic usinv usih`), which
 * is unreadable and unfilterable in a datatable, so the import expands it to
 * one 0/1 column per choice. That expansion is declared here as a `delimited`
 * binding and performed by `expandDelimitedColumns` (survey-normalize.ts).
 *
 * Reference: https://xlsform.org — spec published for third-party implementers.
 */

import type { LocalizedString } from '@/types'
import type {
  Binding,
  QuestionKind,
  SurveyChoice,
  SurveyQuestion,
  SurveySchema,
} from './survey-schema'

/** ODK joins the selected codes of a `select_multiple` with a single space. */
export const XLSFORM_MULTI_SEPARATOR = ' '

/** Rows of the `survey` / `choices` sheets, as parsed into objects. */
export type SheetRows = Record<string, unknown>[]

export interface XlsformSheets {
  survey: SheetRows
  choices: SheetRows
  settings?: SheetRows
}

/**
 * A workbook is an XLSForm when it has the two mandatory sheets. Kept as a
 * suggestion for the UI (which offers a parser dropdown), never a gate.
 */
export function isXlsformWorkbook(sheetNames: string[]): boolean {
  const lower = sheetNames.map((n) => n.trim().toLowerCase())
  return lower.includes('survey') && lower.includes('choices')
}

/** Cell → trimmed string ('' when absent). */
function cell(row: Record<string, unknown>, key: string): string {
  for (const k of Object.keys(row)) {
    if (k.trim().toLowerCase() === key) {
      const v = row[k]
      return v == null ? '' : String(v).trim()
    }
  }
  return ''
}

/**
 * Collect a localized column family: `label`, `label::fr`, `label::French (fr)`.
 *
 * XLSForm allows both `::fr` and `::French (fr)`; the language tag is taken
 * from the parenthesised code when present, else from the whole suffix. A bare
 * `label` with no language becomes the default entry.
 */
function localized(row: Record<string, unknown>, base: string, defaultLang: string): LocalizedString {
  const out: LocalizedString = {}
  for (const key of Object.keys(row)) {
    const k = key.trim()
    const lower = k.toLowerCase()
    if (lower !== base && !lower.startsWith(`${base}::`)) continue
    const value = row[key]
    if (value == null || String(value).trim() === '') continue
    if (lower === base) {
      out[defaultLang] = String(value).trim()
      continue
    }
    const suffix = k.slice(base.length + 2).trim()
    const paren = suffix.match(/\(([^)]+)\)\s*$/)
    const lang = (paren ? paren[1] : suffix).trim().toLowerCase()
    if (lang) out[lang] = String(value).trim()
  }
  return out
}

/** `select_one region` → {kind, listName}. Returns null for non-question rows. */
function parseType(raw: string): { kind: QuestionKind; listName?: string } | null {
  const type = raw.trim()
  if (!type) return null
  const [head, ...rest] = type.split(/\s+/)
  const word = head.toLowerCase()

  // Structural and display-only rows collect no answer.
  if (
    word === 'begin' ||
    word === 'end' ||
    word.startsWith('begin_') ||
    word.startsWith('end_') ||
    word === 'note' ||
    word === 'calculate' ||
    word === 'hidden'
  ) {
    return null
  }

  if (word === 'select_one' || word === 'select_one_from_file') {
    return { kind: 'select_one', listName: rest[0] }
  }
  if (word === 'select_multiple' || word === 'select_multiple_from_file') {
    return { kind: 'select_multiple', listName: rest[0] }
  }
  if (word === 'rank') {
    // A ranking is stored like a multi-select (ordered space-separated codes),
    // but the order carries the answer, so it is not a frequency question.
    return { kind: 'text' }
  }

  switch (word) {
    case 'integer':
      return { kind: 'integer' }
    case 'decimal':
      return { kind: 'decimal' }
    case 'range':
      return { kind: 'range' }
    case 'date':
      return { kind: 'date' }
    case 'datetime':
      return { kind: 'datetime' }
    case 'time':
    case 'text':
    case 'barcode':
      return { kind: 'text' }
    default:
      // geopoint, image, audio, video, file… collect data we cannot chart.
      return null
  }
}

/** Group rows (`begin group` … `end group`) give a question its section. */
function isGroupStart(raw: string): boolean {
  const w = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return w === 'begin' || w === 'begin_group' || w === 'begin_repeat'
}

function isGroupEnd(raw: string): boolean {
  const w = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return w === 'end' || w === 'end_group' || w === 'end_repeat'
}

/**
 * Build the schema from the workbook's sheets.
 *
 * @param sheets       the `survey` / `choices` (/ `settings`) rows
 * @param dataColumns  the response file's column names, when available. Used to
 *                     tell an already-expanded export (Kobo can emit one column
 *                     per choice) from the usual space-delimited one.
 */
export function parseXlsform(sheets: XlsformSheets, dataColumns?: string[]): SurveySchema {
  const defaultLang =
    (sheets.settings?.[0] && cell(sheets.settings[0], 'default_language')) || 'default'
  const available = dataColumns ? new Set(dataColumns) : null

  // choices sheet → { list_name: [{name, label}] }, in sheet order.
  const choices: Record<string, SurveyChoice[]> = {}
  for (const row of sheets.choices) {
    const list = cell(row, 'list_name') || cell(row, 'list name')
    const name = cell(row, 'name')
    if (!list || !name) continue
    const label = localized(row, 'label', defaultLang)
    ;(choices[list] ??= []).push({ name, label })
  }

  const questions: SurveyQuestion[] = []
  const sections: string[] = []

  for (const row of sheets.survey) {
    const rawType = cell(row, 'type')
    if (isGroupEnd(rawType)) {
      sections.pop()
      continue
    }
    if (isGroupStart(rawType)) {
      const groupLabel = localized(row, 'label', defaultLang)
      sections.push(groupLabel[defaultLang] ?? cell(row, 'name'))
      continue
    }

    const parsed = parseType(rawType)
    if (!parsed) continue
    const name = cell(row, 'name')
    if (!name) continue

    const label = localized(row, 'label', defaultLang)
    const hint = localized(row, 'hint', defaultLang)
    const relevant = cell(row, 'relevant')
    const section = sections.length > 0 ? sections[sections.length - 1] : undefined

    const list = parsed.listName ? choices[parsed.listName] : undefined
    const binding = resolveBinding(parsed, name, list, available)
    // A select whose list is missing has nothing to chart.
    if (!binding) continue

    const question: SurveyQuestion = {
      name,
      kind: parsed.kind,
      ...(parsed.listName ? { listName: parsed.listName } : {}),
      label: Object.keys(label).length > 0 ? label : { [defaultLang]: name },
      shortLabel: humanizeName(name),
      ...(Object.keys(hint).length > 0 ? { hint } : {}),
      ...(section ? { section } : {}),
      ...(relevant ? { relevant } : {}),
      binding,
    }

    if (parsed.kind === 'integer' || parsed.kind === 'decimal') {
      question.measure = 'continuous'
    } else if (parsed.kind === 'select_one' || parsed.kind === 'range') {
      question.measure = list && looksOrdinal(list) ? 'ordinal' : 'nominal'
    } else if (parsed.kind === 'select_multiple') {
      question.measure = 'nominal'
    }

    // `or_other` appends a companion text question named `<name>_other`.
    if (/\bor_other\b/.test(rawType)) {
      question.otherQuestion = `${name}_other`
    }

    questions.push(question)
  }

  return { source: 'xlsform', questions, choices }
}

/**
 * A question's physical layout.
 *
 * `select_multiple` is delimited by default (ODK's own storage), but an export
 * that already carries one column per choice — some Kobo exports do — is
 * detected from the available columns and read as one-hot instead, so no
 * expansion is attempted twice.
 */
function resolveBinding(
  parsed: { kind: QuestionKind; listName?: string },
  name: string,
  list: SurveyChoice[] | undefined,
  available: Set<string> | null,
): Binding | null {
  if (parsed.kind !== 'select_multiple') {
    return { kind: 'single_column', column: name }
  }
  if (!list || list.length === 0) return null

  if (available) {
    // ODK names an expanded column `<question>/<choice>`.
    const expanded = list
      .map((c) => ({ code: c.name, column: `${name}/${c.name}` }))
      .filter((c) => available.has(c.column))
    if (expanded.length > 0) return { kind: 'one_hot', columns: expanded }
  }

  return {
    kind: 'delimited',
    column: name,
    separator: XLSFORM_MULTI_SEPARATOR,
    valueKind: 'code',
  }
}

/** Consecutive integer codes (3+) read as an ordered scale. */
function looksOrdinal(list: SurveyChoice[]): boolean {
  if (list.length < 3) return false
  const nums = list.map((c) => Number(c.name))
  if (nums.some((n) => !Number.isInteger(n))) return false
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1)
}

function humanizeName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
