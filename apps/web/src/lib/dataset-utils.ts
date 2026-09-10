import type { DatasetColumn } from '@/types'
import { buildColumnIds } from './column-id'
import { localized } from './localized'

/**
 * Regex matching ISO date (YYYY-MM-DD) and datetime (YYYY-MM-DDTHH:MM:SS) formats,
 * with optional fractional seconds and timezone offset.
 */
export const DATE_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?)?$/

const DATETIME_TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/

/**
 * Tokens treated as missing when no explicit list is configured. Deliberately
 * conservative: only spellings that are unambiguous as "no value". Sentinels
 * like "-" or "." are NOT included — they are legitimate content in some
 * columns, so opting into them is left to the user.
 */
export const DEFAULT_NA_VALUES = ['na', 'n/a', 'null', 'nan', 'none', '#n/a']

const DEFAULT_NA_SET = new Set(DEFAULT_NA_VALUES)
// coerceValue runs per cell, so rebuilding the Set each call would be a hot-path
// allocation on large datasets. Keyed by the caller's array identity.
const naSetCache = new WeakMap<string[], Set<string>>()

/** Normalize a configured NA list for lookup (trimmed, lower-cased, no blanks). */
export function normalizeNaValues(naValues?: string[]): Set<string> {
  if (!naValues) return DEFAULT_NA_SET
  const cached = naSetCache.get(naValues)
  if (cached) return cached
  const set = new Set(naValues.map((v) => v.trim().toLowerCase()).filter((v) => v !== ''))
  naSetCache.set(naValues, set)
  return set
}

/** True when a raw cell reads as missing: null, empty, or one of the NA tokens. */
export function isMissingValue(value: unknown, naSet: Set<string>): boolean {
  if (value == null) return true
  const s = String(value).trim()
  return s === '' || naSet.has(s.toLowerCase())
}

/** Recognized truthy/falsy tokens for boolean columns (EN + FR), case-insensitive. */
const BOOL_TRUE = new Set(['true', '1', 'yes', 'y', 't', 'vrai', 'oui', 'o'])
const BOOL_FALSE = new Set(['false', '0', 'no', 'n', 'f', 'faux', 'non'])

/** Map a raw value to true/false if it is a recognized boolean token, else null. */
export function parseBoolean(value: unknown): boolean | null {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  if (BOOL_TRUE.has(s)) return true
  if (BOOL_FALSE.has(s)) return false
  return null
}

/** The string form used to compare a cell against a target value picked in the UI.
 *  `String(v)` already yields "true"/"false" here, but the same cell is stringified
 *  by pandas ("True"/"False") and R ("TRUE"/"FALSE") when a widget renders on the
 *  server — so the boolean literals are folded to lower case on every side, and a
 *  target chosen from the dropdown matches wherever it is evaluated. Only the
 *  literals are folded: a string column holding "True" as text keeps its casing.
 *  Server mirror: `_linkr_str` in
 *  apps/api/app/services/execution/render/key_indicator.py. */
export function toComparableString(value: unknown): string {
  const s = String(value)
  if (s === 'True' || s === 'TRUE') return 'true'
  if (s === 'False' || s === 'FALSE') return 'false'
  return s
}

/** Coerce a raw cell value to a column's declared type (mirrors the server
 *  dataset_parser `_coerce`): empty → null; number → number when parseable else
 *  the original string; boolean → bool when a known token else the string;
 *  string/date/unknown → the original string. Used when a column's type is
 *  overridden client-side so rows re-read consistently. */
export function coerceValue(
  value: unknown,
  type: DatasetColumn['type'],
  naValues?: string[],
): unknown {
  if (value == null) return null
  const s = String(value)
  if (s === '') return null
  // An NA token is missing data, whatever the column's type.
  if (normalizeNaValues(naValues).has(s.trim().toLowerCase())) return null
  if (type === 'number') {
    const n = Number(s)
    return isNaN(n) ? s : n
  }
  if (type === 'boolean') {
    const b = parseBoolean(s)
    return b === null ? s : b
  }
  return s
}

/**
 * Whether a value can be read as a type, for warning before a retype.
 *
 * Distinct from `coerceValue`, which never fails: it hands back the original string
 * when a value does not fit, and returns dates untouched because a date is STORED as
 * its string. That makes it useless for deciding whether a conversion is lossy, so
 * the question is asked here instead.
 *
 * Missing values always fit: a blank cell is not a failed conversion.
 */
export function fitsColumnType(value: unknown, type: DatasetColumn['type'], naValues?: string[]): boolean {
  if (isMissingValue(value, normalizeNaValues(naValues))) return true
  const s = String(value).trim()
  if (type === 'number') return !isNaN(Number(s))
  if (type === 'boolean') return parseBoolean(s) !== null
  if (type === 'date') return DATE_DATETIME_RE.test(s)
  return true
}

/** Detect whether date-typed values contain time components (for choosing date vs datetime-local input). */
export function hasTimeComponent(values: unknown[]): boolean {
  for (const v of values) {
    if (v != null && v !== '') {
      if (DATETIME_TIME_RE.test(String(v).trim())) return true
    }
  }
  return false
}

/**
 * Infer a column type from a sample of values.
 * Samples up to 200 present values. Priority: boolean > number > date > string.
 *
 * The 200 cap counts values that are actually present: missing ones are dropped
 * first, so a column whose real data only starts after a long run of NA/blank
 * rows is still inferred from its data rather than from the gap.
 */
export function inferColumnType(values: unknown[], naValues?: string[]): DatasetColumn['type'] {
  const naSet = normalizeNaValues(naValues)
  const nonNull = values.filter((v) => !isMissingValue(v, naSet))
  if (nonNull.length === 0) return 'unknown'

  let allNumbers = true
  let allBooleans = true
  let allDates = true

  for (const v of nonNull.slice(0, 200)) {
    const s = String(v).trim()
    if (allNumbers && isNaN(Number(s))) allNumbers = false
    if (allBooleans && parseBoolean(s) === null) allBooleans = false
    if (allDates && !DATE_DATETIME_RE.test(s)) allDates = false
    if (!allNumbers && !allBooleans && !allDates) return 'string'
  }

  if (allBooleans) return 'boolean'
  if (allNumbers) return 'number'
  if (allDates) return 'date'
  return 'string'
}

/** Types a user can force on a column, in menu order ('unknown' is never chosen). */
export const COLUMN_TYPES: DatasetColumn['type'][] = ['string', 'number', 'boolean', 'date']

/** Subtle per-column background tints, alternating with transparent columns for separation. */
export const COLUMN_TINTS = [
  'bg-blue-500/[0.04]',
  '', // transparent
  'bg-violet-500/[0.04]',
  '',
  'bg-emerald-500/[0.04]',
  '',
  'bg-amber-500/[0.04]',
  '',
  'bg-rose-500/[0.04]',
  '',
  'bg-cyan-500/[0.04]',
  '',
]

/** Background tint class for a column at a given index (cycles, every other column transparent). */
export function columnTint(index: number): string {
  return COLUMN_TINTS[index % COLUMN_TINTS.length]
}

/**
 * Human-facing column name: the descriptive label if set, else the technical name.
 * Use everywhere a column name is *shown*; keep `col.name`/`col.id` as the actual key.
 *
 * `lang` is REQUIRED, deliberately. It was optional at first, and an omitted
 * language silently fell back to English — so a caller that simply forgot it looked
 * correct in development and showed the wrong language in production. Worse, three
 * call sites passed the function straight to `.map()`, which handed it the array
 * index as the language. Making it required turns both mistakes into type errors.
 */
export function displayColumnName(
  col: Pick<DatasetColumn, 'name' | 'label'>,
  lang: string,
): string {
  return localized(col.label, lang).trim() || col.name
}

/** Human-facing column description, or '' when there is none. */
export function displayColumnDescription(
  col: Pick<DatasetColumn, 'description'>,
  lang: string,
): string {
  return localized(col.description, lang).trim()
}

/** Localized words for boolean cells, so a `boolean` column reads "Vrai"/"Faux" in
 *  French rather than the storage literals. Callers pass these from `t()`; this
 *  module stays free of i18next so it remains pure and testable. */
export interface BooleanLabels {
  true: string
  false: string
}

/** Human-facing cell value for a categorical column: the mapped value label if one
 *  exists, else a localized boolean word, else the raw code as-is. Display layer
 *  only — never mutate stored cells.
 *
 *  A user-defined `valueLabels` entry wins over `booleanLabels`: it was set
 *  deliberately for this column, so it outranks the generic wording. */
export function displayCellValue(
  col: Pick<DatasetColumn, 'valueLabels' | 'type'>,
  raw: unknown,
  booleanLabels?: BooleanLabels,
): string {
  if (raw == null) return ''
  const key = String(raw)
  const mapped = col.valueLabels?.[key]
  if (mapped != null) return mapped
  // Only for a boolean column: `parseBoolean` also accepts 1/0 and y/n, which
  // must stay as-is in a number or string column.
  if (booleanLabels && col.type === 'boolean') {
    const parsed = parseBoolean(raw)
    if (parsed !== null) return parsed ? booleanLabels.true : booleanLabels.false
  }
  return key
}

/** Build DatasetColumn metadata from raw headers and rows. */
export function buildColumns(
  headers: string[],
  rows: Record<string, unknown>[],
  naValues?: string[],
): DatasetColumn[] {
  const ids = buildColumnIds(headers)
  return headers.map((name, idx) => ({
    id: ids[idx],
    name,
    type: inferColumnType(rows.map((r) => r[name]), naValues),
    order: idx,
  }))
}
