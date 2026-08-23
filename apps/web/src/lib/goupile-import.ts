/**
 * Goupile eCRF import: turn a Goupile XLSX export (multi-sheet) into one wide
 * Linkr dataset, auto-labelled from the export's embedded data dictionary.
 *
 * A Goupile export has one data sheet per form (each starting with the system
 * columns `__tid`/`__sequence`/`__hid`, then the form's variables) plus two
 * dictionary sheets: `@definitions` (variable → label + type) and `@propositions`
 * (categorical code → label). Multi-select variables are one-hot exploded into
 * `variable.prop` columns valued 0/1; missing values are the literal `'NA'`.
 *
 * This module is pure (it takes already-parsed sheet rows, not a File), so it is
 * unit-tested against real exports. The UI (UploadDatasetDialog) reads the workbook
 * with SheetJS, calls `parseGoupileWorkbook`, then feeds the result to the normal
 * dataset-create path and pushes the metadata via POST /dataset-files/columns/meta.
 *
 * Design: docs/planning/goupile-import-plan.md
 */

import type { SurveyChoice, SurveyQuestion, SurveySchema, QuestionKind } from './survey/survey-schema'

/** System columns Goupile prefixes every data sheet with. `__tid` is the join key. */
export const GOUPILE_SYSTEM_COLUMNS = ['__tid', '__sequence', '__hid'] as const

const DEFINITIONS_SHEET = '@definitions'
const PROPOSITIONS_SHEET = '@propositions'

/** A cell value Goupile writes as the literal string "NA" is a missing value. */
function denaturalize(value: unknown): unknown {
  return value === 'NA' ? null : value
}

/** A short, human-friendly label from a technical variable name: underscores → spaces,
 *  first letter capitalized (e.g. "type_structure" → "Type structure"). Goupile has no
 *  clean short label — only the full question — so we derive one from the name. */
function humanizeName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export interface GoupileColumnMeta {
  label?: string
  description?: string
  valueLabels?: Record<string, string>
}

export interface GoupileParseResult {
  /** Wide column names in order (system columns first, then per-form variables). */
  columns: string[]
  /** Joined rows keyed by column name (one row per distinct __tid). */
  rows: Record<string, unknown>[]
  /** Editorial metadata per column name (label/description/valueLabels). */
  columnMeta: Record<string, GoupileColumnMeta>
  /** Forms where the same `__tid` appeared on more than one row. The join keeps one
   *  row per (form, __tid), so a repeatable form's extra entries are dropped —
   *  surface this so the user knows the data isn't silently complete. */
  duplicateForms: string[]
  /** The questionnaire structure behind those columns, in the tool-agnostic model.
   *  Column metadata alone cannot express that a `multi` question owns several
   *  one-hot columns, which is what questionnaire analysis needs. */
  survey: SurveySchema
}

/** Sheets as SheetJS `sheet_to_json` yields them: name → array of row objects. */
export type SheetMap = Record<string, Record<string, unknown>[]>

/**
 * A workbook is a Goupile export when it carries both dictionary sheets. Detection
 * is a suggestion (the UI lets the user opt out), not a hard requirement.
 */
export function isGoupileWorkbook(sheetNames: string[]): boolean {
  return sheetNames.includes(DEFINITIONS_SHEET) && sheetNames.includes(PROPOSITIONS_SHEET)
}

interface Definition {
  label: string
  type: string // 'text' | 'number' | 'enum' | 'multi'
}

/** `@definitions` rows → { "<table><variable>": {label, type} }. */
function readDefinitions(rows: Record<string, unknown>[]): Map<string, Definition> {
  const map = new Map<string, Definition>()
  for (const r of rows) {
    const table = String(r.table ?? '')
    const variable = String(r.variable ?? '')
    if (!variable) continue
    map.set(`${table}\t${variable}`, {
      label: r.label != null ? String(r.label) : '',
      type: r.type != null ? String(r.type) : '',
    })
  }
  return map
}

/** `@propositions` rows → { "<table><variable>": { code: label } }. */
function readPropositions(rows: Record<string, unknown>[]): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>()
  for (const r of rows) {
    const table = String(r.table ?? '')
    const variable = String(r.variable ?? '')
    const prop = r.prop
    if (!variable || prop == null) continue
    const key = `${table}\t${variable}`
    const entry = map.get(key) ?? {}
    entry[String(prop)] = r.label != null ? String(r.label) : String(prop)
    map.set(key, entry)
  }
  return map
}

/**
 * Join every data sheet on `__tid` into one wide dataset and derive column
 * metadata from the dictionary sheets.
 *
 * @param sheets     all workbook sheets (data + `@definitions`/`@propositions`)
 * @param systemMeta label + description for `__tid`/`__sequence`/`__hid` (i18n by the caller)
 */
export function parseGoupileWorkbook(
  sheets: SheetMap,
  systemMeta: Partial<Record<(typeof GOUPILE_SYSTEM_COLUMNS)[number], GoupileColumnMeta>> = {},
): GoupileParseResult {
  const defs = readDefinitions(sheets[DEFINITIONS_SHEET] ?? [])
  const props = readPropositions(sheets[PROPOSITIONS_SHEET] ?? [])

  // Data sheets = every sheet whose name does not start with '@', in workbook order.
  const dataSheetNames = Object.keys(sheets).filter((n) => !n.startsWith('@'))

  // First pass: figure out which non-system column names collide across ≥2 forms,
  // so we can prefix ONLY those (recours_mir.remarques vs perspectives.remarques).
  const nameOccurrences = new Map<string, Set<string>>()
  for (const sheetName of dataSheetNames) {
    const rows = sheets[sheetName] ?? []
    const headers = rows.length > 0 ? Object.keys(rows[0]) : []
    for (const h of headers) {
      if ((GOUPILE_SYSTEM_COLUMNS as readonly string[]).includes(h)) continue
      const set = nameOccurrences.get(h) ?? new Set<string>()
      set.add(sheetName)
      nameOccurrences.set(h, set)
    }
  }
  const collides = (name: string) => (nameOccurrences.get(name)?.size ?? 0) > 1

  // The wide column name for a raw variable in a given form (collision-only prefix,
  // dot separator to match Goupile's own `var.prop` one-hot dotting).
  const wideName = (sheetName: string, rawName: string) =>
    collides(rawName) ? `${sheetName}.${rawName}` : rawName

  // Build the ordered column list + metadata, and accumulate rows keyed by __tid.
  const columns: string[] = [...GOUPILE_SYSTEM_COLUMNS]
  const columnMeta: Record<string, GoupileColumnMeta> = {}
  for (const sys of GOUPILE_SYSTEM_COLUMNS) {
    if (systemMeta[sys]) columnMeta[sys] = { ...systemMeta[sys] }
  }

  const byTid = new Map<string, Record<string, unknown>>()
  const tidOrder: string[] = []
  const duplicateForms: string[] = []

  for (const sheetName of dataSheetNames) {
    const rows = sheets[sheetName] ?? []
    // Union the keys of EVERY row, not just rows[0]: a ragged sheet whose first row
    // omits a column (blank cell) would otherwise drop that column entirely.
    const variableHeaders: string[] = []
    for (const row of rows) {
      for (const h of Object.keys(row)) {
        if ((GOUPILE_SYSTEM_COLUMNS as readonly string[]).includes(h)) continue
        if (!variableHeaders.includes(h)) variableHeaders.push(h)
      }
    }

    // Register this sheet's columns (once) with their dictionary metadata.
    for (const raw of variableHeaders) {
      const wide = wideName(sheetName, raw)
      if (!columns.includes(wide)) columns.push(wide)
      columnMeta[wide] = deriveColumnMeta(sheetName, raw, defs, props)
    }

    // Merge each row into the joined table by __tid. A repeatable form can have >1
    // row per __tid; the join keeps one (last-write-wins), so flag such a form.
    const seenTidsThisSheet = new Set<string>()
    let sheetHasDuplicate = false
    for (const row of rows) {
      const tid = row.__tid != null ? String(row.__tid) : ''
      if (!tid) continue // a data sheet with no __tid can't be joined; skip the row
      if (seenTidsThisSheet.has(tid)) sheetHasDuplicate = true
      seenTidsThisSheet.add(tid)
      let target = byTid.get(tid)
      if (!target) {
        target = {}
        byTid.set(tid, target)
        tidOrder.push(tid)
      }
      // System columns: take the first non-null seen (all sheets of a thread agree).
      for (const sys of GOUPILE_SYSTEM_COLUMNS) {
        if (target[sys] == null && row[sys] != null) target[sys] = denaturalize(row[sys])
      }
      for (const raw of variableHeaders) {
        target[wideName(sheetName, raw)] = denaturalize(row[raw])
      }
    }
    if (sheetHasDuplicate) duplicateForms.push(sheetName)
  }

  const rows = tidOrder.map((tid) => {
    const merged = byTid.get(tid)!
    // Ensure every column key exists on every row (nulls for absent forms).
    const full: Record<string, unknown> = {}
    for (const col of columns) full[col] = merged[col] ?? null
    return full
  })

  const survey = buildSurveySchema(columns, defs, props, dataSheetNames, wideName)

  return { columns, rows, columnMeta, duplicateForms, survey }
}

/**
 * Derive the questionnaire structure from the dictionary + the wide column list.
 *
 * A `multi` variable has NO column of its own — only its one-hot `var.prop`
 * children — so it is rebuilt from `@definitions`, gathering the children that
 * actually made it into the wide table. Every other type maps to a single column.
 *
 * Choice lists are named after the form + variable that declared them: Goupile
 * declares propositions per variable, with no shared-list concept, so there is
 * no sharing to preserve.
 */
function buildSurveySchema(
  columns: string[],
  defs: Map<string, Definition>,
  props: Map<string, Record<string, string>>,
  dataSheetNames: string[],
  wideName: (sheetName: string, rawName: string) => string,
): SurveySchema {
  const present = new Set(columns)
  const questions: SurveyQuestion[] = []
  const choices: Record<string, SurveyChoice[]> = {}

  for (const sheetName of dataSheetNames) {
    for (const [key, def] of defs) {
      const [table, variable] = key.split('\t')
      if (table !== sheetName) continue

      const propLabels = props.get(key)
      const listName = `${sheetName}_${variable}`

      if (def.type === 'multi') {
        // Children are named `<variable>.<prop>` inside the form, then possibly
        // prefixed by the form when the name collides across forms.
        const list: SurveyChoice[] = []
        const oneHot: { code: string; column: string }[] = []
        for (const [code, label] of Object.entries(propLabels ?? {})) {
          const column = wideName(sheetName, `${variable}.${code}`)
          if (!present.has(column)) continue
          list.push({ name: code, label: { fr: label } })
          oneHot.push({ code, column })
        }
        if (oneHot.length === 0) continue
        choices[listName] = list
        questions.push({
          name: wideName(sheetName, variable),
          kind: 'select_multiple',
          listName,
          label: { fr: def.label || variable },
          shortLabel: humanizeName(variable),
          section: sheetName,
          measure: 'nominal',
          binding: { kind: 'one_hot', columns: oneHot },
        })
        continue
      }

      const column = wideName(sheetName, variable)
      if (!present.has(column)) continue

      const kind = goupileKind(def.type)
      const question: SurveyQuestion = {
        name: column,
        kind,
        label: { fr: def.label || variable },
        shortLabel: humanizeName(variable),
        section: sheetName,
        binding: { kind: 'single_column', column },
      }
      if (kind === 'select_one' && propLabels && Object.keys(propLabels).length > 0) {
        choices[listName] = Object.entries(propLabels).map(([code, label]) => ({
          name: code,
          label: { fr: label },
        }))
        question.listName = listName
        question.measure = looksOrdinal(Object.keys(propLabels)) ? 'ordinal' : 'nominal'
      } else if (kind === 'integer' || kind === 'decimal') {
        question.measure = 'continuous'
      }
      questions.push(question)
    }
  }

  return { source: 'goupile', questions, choices, respondentIdColumn: '__tid' }
}

/** Consecutive integer codes (3+) read as an ordered scale rather than
 *  unordered categories — a 1..5 satisfaction must keep its order. */
function looksOrdinal(codes: string[]): boolean {
  if (codes.length < 3) return false
  const nums = codes.map(Number)
  if (nums.some((n) => !Number.isInteger(n))) return false
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1)
}

function goupileKind(type: string): QuestionKind {
  switch (type) {
    case 'enum':
      return 'select_one'
    case 'number':
      return 'integer'
    case 'date':
      return 'date'
    default:
      return 'text'
  }
}

/**
 * Metadata for one wide column from the dictionary. The Goupile `label` is the
 * full question asked — too long for a column label, so it becomes the column
 * DESCRIPTION; the column keeps its technical name as its visible name.
 * - one-hot `<var>.<prop>` (parent is a `multi`): a short, meaningful `label` is
 *   the proposition text (e.g. "Détresse vitale"); the parent question is the
 *   description. It's a 0/1 flag, so no valueLabels.
 * - plain `enum`: description = the question, valueLabels = its code→label map.
 * - plain number/text: description = the question.
 */
function deriveColumnMeta(
  table: string,
  rawName: string,
  defs: Map<string, Definition>,
  props: Map<string, Record<string, string>>,
): GoupileColumnMeta {
  // One-hot column? Its raw name is `<variable>.<prop>` and `<variable>` is a multi.
  const dot = rawName.indexOf('.')
  if (dot > 0) {
    const parentVar = rawName.slice(0, dot)
    const prop = rawName.slice(dot + 1)
    const parentDef = defs.get(`${table}\t${parentVar}`)
    if (parentDef?.type === 'multi') {
      const propLabels = props.get(`${table}\t${parentVar}`)
      const meta: GoupileColumnMeta = {}
      const propLabel = propLabels?.[prop]
      if (propLabel) meta.label = propLabel // the proposition is a good short label
      if (parentDef.label) meta.description = parentDef.label
      return meta
    }
  }

  const def = defs.get(`${table}\t${rawName}`)
  if (!def) return {}
  const meta: GoupileColumnMeta = {}
  // Short label from the variable name; the full question is the description.
  meta.label = humanizeName(rawName)
  if (def.label) meta.description = def.label
  if (def.type === 'enum') {
    const valueLabels = props.get(`${table}\t${rawName}`)
    if (valueLabels && Object.keys(valueLabels).length > 0) meta.valueLabels = { ...valueLabels }
  }
  return meta
}
