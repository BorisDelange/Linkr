/**
 * The questionnaire model every eCRF import normalises to.
 *
 * This is XLSForm's vocabulary — `select_one` / `select_multiple`, named choice
 * lists, localized labels — rather than one of our own. XLSForm is the only
 * existing standard that natively declares everything a questionnaire needs
 * (multi-select as a first-class type, "other, specify", branching, i18n), it is
 * spreadsheet-authorable, and it is what ODK, KoboToolbox, SurveyCTO, Ona and
 * OpenClinica 4 all speak. CDISC ODM was the alternative and was rejected: it
 * has no multi-select primitive at all (its own "check all that apply" example
 * needs six nested XML blocks per respondent, and ships three more encodings
 * commented out as undecided). See docs/planning/survey-plugin-plan.md §1.5.
 *
 * What XLSForm does NOT describe is how answers were laid out in the export
 * file — it describes forms, not exports. That is what `binding` adds, and it is
 * our only extension to the standard.
 *
 * This schema is stored in the dataset's metadata sidecar under a `survey` key,
 * alongside the existing per-column `columns` entries. It references columns by
 * NAME, never by id: ids are derived deterministically from names
 * (see lib/column-id.ts), so a name-keyed schema survives re-import unchanged.
 */

import type { LocalizedString } from '@/types'

/**
 * An XLSForm question type. The string form (`select_one <list>`) is XLSForm's
 * own, but we keep the parsed pieces rather than re-parsing the string
 * everywhere — `type` is the bare kind and `listName` the choice list it points
 * at.
 */
export type QuestionKind =
  /** `select_one <list>` — one choice among a list. */
  | 'select_one'
  /** `select_multiple <list>` — any number of choices from a list. */
  | 'select_multiple'
  | 'integer'
  | 'decimal'
  | 'text'
  | 'date'
  | 'datetime'
  /** XLSForm's `range`, and any 1..n rating collected as a scale. */
  | 'range'

/**
 * How a question's answers are physically laid out in the imported table.
 *
 * The three shapes cover every tool we surveyed. This is the one thing no
 * questionnaire standard describes, because it belongs to the export rather
 * than the form, and it cannot be inferred reliably: five different name
 * separators and three different truth values are in use, and Castor even
 * disagrees with itself between its CSV export and its API.
 */
export type Binding =
  /** One column holds the answer (single choice, number, text, date). */
  | {
      kind: 'single_column'
      column: string
      /** Raw cell value → choice code, when the export stores something other
       *  than the code itself (e.g. LimeSurvey's `Y`, a label instead of a code). */
      valueMap?: Record<string, string>
    }
  /**
   * One 0/1-style column per choice — REDCap `q___code`, Goupile `q.code`,
   * Castor `q#code`. This is also the shape we STORE, whatever the source: it
   * is the only one that stays readable and filterable in the datatable.
   */
  | {
      kind: 'one_hot'
      columns: { code: string; column: string }[]
      /** The value meaning "ticked". Defaults to the usual 1/true/yes family;
       *  set explicitly for exports that disagree (LimeSurvey writes `Y`, and
       *  with its Y/N conversion on, `1` = yes but **`2` = no**). */
      trueValue?: string
    }
  /**
   * One column holding several codes at once — ODK/XLSForm (space), Qualtrics
   * (comma), OpenClinica (comma), Castor's API (semicolon). Supported on INPUT
   * and expanded to `one_hot` at import: a cell reading `usic usinv usih` is
   * unreadable in a datatable and cannot be filtered.
   */
  | {
      kind: 'delimited'
      column: string
      separator: string
      /** Whether the cell holds choice codes or their labels. Google and
       *  Microsoft Forms only ever emit labels, which makes an option literally
       *  named `Yes, sometimes` ambiguous in a comma-joined cell. */
      valueKind: 'code' | 'label'
    }

/** One selectable answer, XLSForm's `choices` sheet row. */
export interface SurveyChoice {
  /** XLSForm `name` — the value stored in the data. */
  name: string
  label: LocalizedString
}

export interface SurveyQuestion {
  /** XLSForm `name` — the variable name, unique within the questionnaire. */
  name: string
  kind: QuestionKind
  /** For `select_one`/`select_multiple`: which list in `choices` it uses. */
  listName?: string
  /** The question as asked. */
  label: LocalizedString
  /** A short label for axes and chips, when the full question is too long. */
  shortLabel?: string
  /** XLSForm `hint` — guidance shown under the question. */
  hint?: LocalizedString
  /** The group/form/section the question belongs to. */
  section?: string
  /**
   * Whether the answers are unordered categories, an ordered scale, or a
   * quantity. No export format except SPSS declares this, yet it decides which
   * chart is correct — a `select_one` coded 1..5 is a Likert scale, one coded
   * by name is not. Importers infer it; the user can override it.
   */
  measure?: 'nominal' | 'ordinal' | 'continuous'
  /**
   * XLSForm `relevant` — the question was only asked when this held, so its
   * denominator is the branch, not the whole sample. Kept as the source
   * expression (opaque, tool-specific): enough to warn the reader, not to
   * evaluate.
   */
  relevant?: string
  /** XLSForm `or_other`: the companion free-text question's name. */
  otherQuestion?: string
  binding: Binding
}

export interface SurveySchema {
  /** Which tool the export came from. Recorded for provenance and for the
   *  quirks that survive normalisation. */
  source: SurveySource
  questions: SurveyQuestion[]
  /** Choice lists, keyed by XLSForm `list_name` and shared across questions. */
  choices: Record<string, SurveyChoice[]>
  /** Column holding the respondent identifier, when the export has one. */
  respondentIdColumn?: string
}

export type SurveySource =
  | 'goupile'
  | 'redcap'
  | 'xlsform'
  | 'limesurvey'
  | 'qualtrics'
  | 'castor'
  | 'openclinica'
  | 'generic'

/** The sidecar key this schema is stored under, beside `columns`. */
export const SURVEY_SIDECAR_KEY = 'survey'

/** Questions whose answers form categories — those a frequency chart fits. */
export function isCategorical(q: SurveyQuestion): boolean {
  return q.kind === 'select_one' || q.kind === 'select_multiple' || q.kind === 'range'
}

/** Questions holding a quantity. */
export function isNumeric(q: SurveyQuestion): boolean {
  return q.kind === 'integer' || q.kind === 'decimal'
}

export function findQuestion(schema: SurveySchema, name: string): SurveyQuestion | undefined {
  return schema.questions.find((q) => q.name === name)
}

/** The choice list a question points at, or [] when it has none. */
export function questionChoices(schema: SurveySchema, q: SurveyQuestion): SurveyChoice[] {
  return q.listName ? (schema.choices[q.listName] ?? []) : []
}

/**
 * Every dataset column a question occupies, in choice order for `one_hot`.
 * The single place that knows how to walk a binding, so callers never
 * switch on `binding.kind` themselves.
 */
export function questionColumns(q: SurveyQuestion): string[] {
  switch (q.binding.kind) {
    case 'one_hot':
      return q.binding.columns.map((c) => c.column)
    case 'single_column':
    case 'delimited':
      return [q.binding.column]
  }
}

/** The column carrying a given choice, for a `one_hot` question. */
export function choiceColumn(q: SurveyQuestion, code: string): string | undefined {
  if (q.binding.kind !== 'one_hot') return undefined
  return q.binding.columns.find((c) => c.code === code)?.column
}
