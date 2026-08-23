/**
 * REDCap import: turn a REDCap "Data Dictionary" CSV into a `SurveySchema`
 * describing the companion data export.
 *
 * Unlike Goupile (whose dictionary travels inside the data workbook), REDCap
 * ships the dictionary as a SEPARATE CSV, so the user supplies two files. The
 * data export itself needs no reshaping — it is already one row per record —
 * which is why this module only produces a schema and never rewrites rows.
 *
 * Conventions this relies on (stable across REDCap versions):
 * - a checkbox field `q` is exported as one column per choice, named `q___code`,
 *   valued 0/1, with `code` lowercased and non-alphanumerics turned into `_`;
 * - `yesno` is 1/0, `truefalse` is 1/0;
 * - `Choices, Calculations, OR Slider Labels` holds `code, label | code, label`;
 * - each form contributes a `<form>_complete` column that is not a question.
 */

import type { SurveyChoice, SurveyQuestion, SurveySchema, QuestionKind } from './survey-schema'

/** Dictionary column headers, in REDCap's canonical order. Matching is done on a
 *  normalised form so exports that vary in case/punctuation still line up. */
const FIELD_NAME = 'variable / field name'
const FORM_NAME = 'form name'
const SECTION_HEADER = 'section header'
const FIELD_TYPE = 'field type'
const FIELD_LABEL = 'field label'
const CHOICES = 'choices, calculations, or slider labels'
const FIELD_NOTE = 'field note'
const VALIDATION = 'text validation type or show slider number'
const BRANCHING = 'branching logic (show field only if...)'

/** Field types that carry no answer, so they are not questions. */
const NON_QUESTION_TYPES = new Set(['descriptive', 'file', 'calc'])

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^"|"$/g, '')
}

/**
 * REDCap's own slug for a checkbox choice code, used to build `q___code`
 * columns: lowercase, and every run of non-alphanumerics becomes a single `_`.
 * `-1` becomes `_1`, so a leading `-` is not simply dropped.
 */
export function redcapChoiceSlug(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

/**
 * Parse a `Choices` cell: `code, label | code, label`. Only the FIRST comma
 * separates code from label — labels routinely contain commas
 * (`chu_chr, CHU, CHR ou assimilé`).
 */
export function parseRedcapChoices(raw: string): SurveyChoice[] {
  const out: SurveyChoice[] = []
  for (const part of raw.split('|')) {
    const segment = part.trim()
    if (!segment) continue
    const comma = segment.indexOf(',')
    if (comma < 0) {
      out.push({ name: segment, label: { en: segment } })
      continue
    }
    const code = segment.slice(0, comma).trim()
    const label = segment.slice(comma + 1).trim()
    if (!code) continue
    out.push({ name: code, label: { en: label || code } })
  }
  return out
}

/** A REDCap field type + its validation → an XLSForm question kind. */
function mapKind(fieldType: string, validation: string): QuestionKind | null {
  const ft = fieldType.trim().toLowerCase()
  if (NON_QUESTION_TYPES.has(ft)) return null
  switch (ft) {
    case 'checkbox':
      return 'select_multiple'
    case 'radio':
    case 'dropdown':
    case 'yesno':
    case 'truefalse':
      return 'select_one'
    case 'slider':
      return 'integer'
    case 'notes':
      return 'text'
    case 'text': {
      // A plain text field is only numeric/date when its validation says so.
      const v = validation.trim().toLowerCase()
      if (!v) return 'text'
      if (v.startsWith('date') || v.startsWith('datetime')) return 'date'
      if (v === 'time') return 'text'
      if (v.startsWith('integer')) return 'integer'
      if (v.startsWith('number')) return 'decimal'
      return 'text'
    }
    default:
      return 'text'
  }
}

/** The implicit choice list of a yes/no or true/false field. */
function booleanChoices(fieldType: string): SurveyChoice[] {
  const isTrueFalse = fieldType.trim().toLowerCase() === 'truefalse'
  return [
    { name: '1', label: { en: isTrueFalse ? 'True' : 'Yes', fr: isTrueFalse ? 'Vrai' : 'Oui' } },
    { name: '0', label: { en: isTrueFalse ? 'False' : 'No', fr: isTrueFalse ? 'Faux' : 'Non' } },
  ]
}

/**
 * A radio whose codes are consecutive integers is an ordered scale (a 1–5
 * satisfaction), which changes which chart is correct. Two codes stay nominal —
 * that is a binary, not a scale.
 */
function looksOrdinal(choices: SurveyChoice[]): boolean {
  if (choices.length < 3) return false
  const nums = choices.map((c) => Number(c.name))
  if (nums.some((n) => !Number.isInteger(n))) return false
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1)
}

/** Rows of the dictionary CSV, already parsed into objects (header → cell). */
export type RedcapDictionaryRows = Record<string, unknown>[]

/**
 * A CSV is a REDCap data dictionary when it carries the field-name and
 * field-type headers. Detection is a suggestion, not a gate.
 */
export function isRedcapDictionary(headers: string[]): boolean {
  const set = new Set(headers.map(normaliseHeader))
  return set.has(FIELD_NAME) && set.has(FIELD_TYPE)
}

/**
 * Build the survey schema from dictionary rows.
 *
 * @param rows          the dictionary CSV as row objects
 * @param dataColumns   the data export's column names. Used to resolve a
 *                      checkbox's real `q___code` columns and to drop fields
 *                      that were never exported. When omitted, checkbox columns
 *                      are derived from the choice codes.
 */
export function parseRedcapDictionary(
  rows: RedcapDictionaryRows,
  dataColumns?: string[],
): SurveySchema {
  const available = dataColumns ? new Set(dataColumns) : null
  const questions: SurveyQuestion[] = []
  const choiceLists: Record<string, SurveyChoice[]> = {}
  let respondentIdColumn: string | undefined

  // Re-key each row by normalised header so header casing/spacing can't break us.
  const get = (row: Record<string, unknown>, key: string): string => {
    for (const k of Object.keys(row)) {
      if (normaliseHeader(k) === key) {
        const v = row[k]
        return v == null ? '' : String(v)
      }
    }
    return ''
  }

  rows.forEach((row, index) => {
    const name = get(row, FIELD_NAME).trim()
    if (!name) return

    // REDCap's first field is always the record identifier, whatever its name.
    if (index === 0 && respondentIdColumn === undefined) respondentIdColumn = name

    const fieldType = get(row, FIELD_TYPE)
    const validation = get(row, VALIDATION)
    const kind = mapKind(fieldType, validation)
    if (!kind) return

    const label = get(row, FIELD_LABEL).trim() || name
    const section = get(row, SECTION_HEADER).trim() || get(row, FORM_NAME).trim() || undefined
    const hint = get(row, FIELD_NOTE).trim() || undefined
    const relevant = get(row, BRANCHING).trim() || undefined

    const question: SurveyQuestion = {
      name,
      kind,
      label: { en: label },
      shortLabel: humanizeName(name),
      ...(hint ? { hint: { en: hint } } : {}),
      ...(section ? { section } : {}),
      ...(relevant ? { relevant } : {}),
      // Placeholder; every branch below sets the real binding.
      binding: { kind: 'single_column', column: name },
    }

    if (kind === 'select_multiple') {
      // A checkbox is exported as one `field___code` column per option; keep
      // only the options whose column actually made it into the export.
      const parsed = parseRedcapChoices(get(row, CHOICES))
      const list: SurveyChoice[] = []
      const oneHot: { code: string; column: string }[] = []
      for (const c of parsed) {
        const column = `${name}___${redcapChoiceSlug(c.name)}`
        if (available && !available.has(column)) continue
        list.push(c)
        oneHot.push({ code: c.name, column })
      }
      if (oneHot.length === 0) return
      choiceLists[name] = list
      question.listName = name
      question.measure = 'nominal'
      question.binding = { kind: 'one_hot', columns: oneHot }
    } else {
      if (available && !available.has(name)) return
      question.binding = { kind: 'single_column', column: name }
      if (kind === 'select_one') {
        const isBool = fieldType.trim().toLowerCase() === 'yesno' || fieldType.trim().toLowerCase() === 'truefalse'
        const list = isBool ? booleanChoices(fieldType) : parseRedcapChoices(get(row, CHOICES))
        if (list.length > 0) {
          choiceLists[name] = list
          question.listName = name
          question.measure = looksOrdinal(list) ? 'ordinal' : 'nominal'
        }
      } else if (kind === 'integer' || kind === 'decimal') {
        question.measure = 'continuous'
      }
    }

    questions.push(question)
  })

  return {
    source: 'redcap',
    questions,
    choices: choiceLists,
    ...(respondentIdColumn ? { respondentIdColumn } : {}),
  }
}

/** `type_structure` → `Type structure`, matching the Goupile importer's rule. */
function humanizeName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Columns REDCap adds that are bookkeeping, not answers. */
export function isRedcapSystemColumn(column: string): boolean {
  return column.endsWith('_complete') || column.endsWith('_timestamp') || column === 'redcap_event_name'
}
